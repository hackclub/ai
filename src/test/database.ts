import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { $ } from "bun";
import postgres from "postgres";

import { createBlobStore } from "../analytics/bodies";
import { migrateJobQueue } from "../analytics/worker";

const SERVER_URL = process.env.TEST_DATABASE_URL ?? "postgres://hcai:hcai@localhost:55432/postgres";
const CLICKHOUSE = {
  url: process.env.TEST_CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.TEST_CLICKHOUSE_USER ?? "hcai",
  password: process.env.TEST_CLICKHOUSE_PASSWORD ?? "hcai",
};
const MIGRATIONS = "migrations/postgres";
const TEMPLATE_PREFIX = "hcai_tpl_";
const DATABASE_PREFIX = "hcai_t_";
/** A run database older than this was left by a crashed run. */
const ORPHAN_AGE_S = 60 * 60;

const urlFor = (database: string) => {
  const url = new URL(SERVER_URL);
  url.pathname = `/${database}`;
  return url.toString();
};

const admin = postgres(urlFor("postgres"), {
  max: 1,
  idle_timeout: 1,
  connect_timeout: 5,
  onnotice: () => {},
});

const unreachable = (cause: unknown) =>
  new Error(
    `bun test needs a running PostgreSQL 18 at ${redact(SERVER_URL)}. ` +
      "Start one with `bun run db:up`, or set TEST_DATABASE_URL to a server this role can create databases on.",
    { cause },
  );

const templateHash = async () => {
  const hash = createHash("sha256");
  for (const file of (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort()) {
    hash.update(file).update(await Bun.file(`${MIGRATIONS}/${file}`).text());
  }
  hash.update(await Bun.file("node_modules/graphile-worker/package.json").text());
  return hash.digest("hex").slice(0, 16);
};

const databases = async (prefix: string) =>
  (await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE ${`${prefix}%`}`).map(
    (row) => row.datname,
  );

const buildTemplate = async (name: string) => {
  const scratch = `${name}_wip`;
  await admin`DROP DATABASE IF EXISTS ${admin(scratch)} WITH (FORCE)`;
  await admin`CREATE DATABASE ${admin(scratch)}`;
  const migrated = await $`bun scripts/migrate.ts --only=postgres`
    .env({ ...process.env, DATABASE_URL: urlFor(scratch) })
    .quiet()
    .nothrow();
  if (migrated.exitCode !== 0) {
    throw new Error(`Migrating the test template failed:\n${migrated.stderr.toString()}${migrated.stdout.toString()}`);
  }
  await migrateJobQueue(urlFor(scratch));
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${scratch}`;
  await admin`ALTER DATABASE ${admin(scratch)} RENAME TO ${admin(name)}`;
};

const prepare = async () => {
  try {
    const [row] = await admin<{ version: number }[]>`SELECT current_setting('server_version_num')::int AS version`;
    if (!row || row.version < 180_000) {
      throw new Error(`Tests need PostgreSQL 18; ${redact(SERVER_URL)} runs ${row?.version ?? "an unknown version"}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Tests need")) throw error;
    throw unreachable(error);
  }

  const template = `${TEMPLATE_PREFIX}${await templateHash()}`;
  await admin`SELECT pg_advisory_lock(hashtext('hcai_test_template'))`;
  try {
    const existing = await databases(TEMPLATE_PREFIX);
    if (!existing.includes(template)) await buildTemplate(template);
    for (const stale of existing.filter((name) => name !== template && !name.endsWith("_wip"))) {
      await admin`DROP DATABASE IF EXISTS ${admin(stale)}`.catch(() => {});
    }
    const cutoff = Math.floor(Date.now() / 1000) - ORPHAN_AGE_S;
    for (const orphan of await databases(DATABASE_PREFIX)) {
      const created = Number(orphan.slice(DATABASE_PREFIX.length).split("_")[0]);
      if (created < cutoff) await admin`DROP DATABASE IF EXISTS ${admin(orphan)} WITH (FORCE)`;
    }
  } finally {
    await admin`SELECT pg_advisory_unlock(hashtext('hcai_test_template'))`;
  }
  return template;
};

const resetTables = async (sql: postgres.Sql) => {
  const tables = await sql<{ name: string }[]>`
    SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
    WHERE (schemaname = 'public' AND tablename <> 'schema_migrations')
       OR (schemaname = 'graphile_worker' AND tablename IN ('_private_jobs', '_private_job_queues'))
  `;
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const { name } of tables) await tx.unsafe(`DELETE FROM ${name}`);
  });
};

const newDatabaseName = () => `${DATABASE_PREFIX}${Math.floor(Date.now() / 1000)}_${crypto.randomUUID().slice(0, 8)}`;

const clickhouseAdmin = createClient({ ...CLICKHOUSE, request_timeout: 30_000 });

const clickhouseUnreachable = (cause: unknown) =>
  new Error(
    `bun test needs a running ClickHouse at ${CLICKHOUSE.url}. ` +
      "Start one with `bun run db:up`, or set TEST_CLICKHOUSE_URL (and TEST_CLICKHOUSE_USER / TEST_CLICKHOUSE_PASSWORD).",
    { cause },
  );

const prepareClickHouse = async (name: string, postgresUrl: string) => {
  const ping = await clickhouseAdmin.ping();
  if (!ping.success) throw clickhouseUnreachable(ping.error);

  const cutoff = Math.floor(Date.now() / 1000) - ORPHAN_AGE_S;
  const listed = await clickhouseAdmin.query({
    query: "SELECT name FROM system.databases WHERE startsWith(name, {prefix:String})",
    query_params: { prefix: DATABASE_PREFIX },
    format: "JSONEachRow",
  });
  for (const { name: orphan } of await listed.json<{ name: string }>()) {
    if (Number(orphan.slice(DATABASE_PREFIX.length).split("_")[0]) < cutoff) {
      await clickhouseAdmin.command({ query: `DROP DATABASE IF EXISTS \`${orphan}\`` });
    }
  }

  await clickhouseAdmin.command({ query: `CREATE DATABASE \`${name}\`` });
  const migrated = await $`bun scripts/migrate.ts --only=clickhouse`
    .env({
      ...process.env,
      // The runner takes its lock in PostgreSQL even for ClickHouse.
      DATABASE_URL: postgresUrl,
      CLICKHOUSE_URL: CLICKHOUSE.url,
      CLICKHOUSE_USER: CLICKHOUSE.username,
      CLICKHOUSE_PASSWORD: CLICKHOUSE.password,
      CLICKHOUSE_DB: name,
    })
    .quiet()
    .nothrow();
  if (migrated.exitCode !== 0) {
    throw new Error(`Migrating the test ClickHouse database failed:\n${migrated.stderr.toString()}${migrated.stdout.toString()}`);
  }
};

let run: Promise<string> | undefined;

export const prepareTestDatabases = () =>
  (run ??= prepare().then(async (template) => {
    const name = newDatabaseName();
    await admin`CREATE DATABASE ${admin(name)} TEMPLATE ${admin(template)}`;
    await prepareClickHouse(name, urlFor(name));
    return name;
  }));

export const dropTestDatabases = async () => {
  if (!run) return;
  const name = await run.catch(() => null);
  if (name) {
    await admin`DROP DATABASE IF EXISTS ${admin(name)} WITH (FORCE)`;
    await clickhouseAdmin.command({ query: `DROP DATABASE IF EXISTS \`${name}\`` });
  }
  await admin.end();
  await clickhouseAdmin.close();
};

export type TestDatabase = { sql: postgres.Sql; url: string };

export const testDatabase = async ({ empty = false } = {}): Promise<TestDatabase> => {
  if (empty) {
    await prepareTestDatabases();
    const name = newDatabaseName();
    await admin`CREATE DATABASE ${admin(name)}`;
    const url = urlFor(name);
    const sql = postgres(url, { max: 4, onnotice: () => {} });
    afterAll(async () => {
      await sql.end();
      await admin`DROP DATABASE IF EXISTS ${admin(name)} WITH (FORCE)`;
    });
    return { sql, url };
  }
  const url = urlFor(await prepareTestDatabases());
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  await resetTables(sql);
  afterAll(() => sql.end());
  return { sql, url };
};

export type TestClickHouse = {
  clickhouse: ClickHouseClient;
  config: { url: string; username: string; password: string; database: string };
};

export const testClickHouse = async (): Promise<TestClickHouse> => {
  const database = await prepareTestDatabases();
  const config = { ...CLICKHOUSE, database };
  const clickhouse = createClient(config);
  const tables = await clickhouse.query({
    query: "SELECT name FROM system.tables WHERE database = currentDatabase() AND name <> 'schema_migrations'",
    format: "JSONEachRow",
  });
  for (const { name } of await tables.json<{ name: string }>()) {
    await clickhouse.command({ query: `TRUNCATE TABLE \`${name}\`` });
  }
  afterAll(() => clickhouse.close());
  return { clickhouse, config };
};

const BLOB_STORE = {
  endpoint: process.env.TEST_BLOB_STORE_URL ?? "http://localhost:3900",
  bucket: "request-blobs",
  region: "garage",
  accessKeyId: "GK000000000000000000000000",
  secretAccessKey: "0000000000000000000000000000000000000000000000000000000000000000",
};

let blobStoreReady: Promise<void> | undefined;

export const testBlobStore = async () => {
  const blobStore = createBlobStore(BLOB_STORE);
  await (blobStoreReady ??= blobStore.list({ maxKeys: 1 }).then(
    () => {},
    (cause: unknown) => {
      throw new Error(
        `bun test needs a running Garage at ${BLOB_STORE.endpoint}. Start one with \`bun run db:up\`, or set TEST_BLOB_STORE_URL.`,
        { cause },
      );
    },
  ));
  return blobStore;
};

const redact = (value: string) => {
  try {
    const parsed = new URL(value);
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return "<unparseable url>";
  }
};
