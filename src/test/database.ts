import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { $ } from "bun";
import postgres from "postgres";

import { migrateJobQueue } from "../analytics/worker";

/**
 * Real PostgreSQL and ClickHouse for tests (docs/adr/0001). Each `bun test`
 * run clones one PostgreSQL database from a template that holds the
 * migrated schema and the Graphile job queue, and creates a ClickHouse
 * database of the same name; every test file starts with their rows
 * cleared. The template is named after a hash of everything that shapes it,
 * so a new migration builds a new one.
 *
 * Servers are never started here: `bun run db:up`, or point
 * TEST_DATABASE_URL at any PostgreSQL 18 server the role can create
 * databases on and TEST_CLICKHOUSE_URL at a ClickHouse server.
 */

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
      "Start one with `bun run db:up`, or set TEST_DATABASE_URL to a server this role can create databases on. " +
      "Tests never fall back to a fake billing engine (docs/adr/0001).",
    { cause },
  );

const templateHash = async () => {
  const hash = createHash("sha256");
  for (const file of (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort()) {
    hash.update(file).update(await Bun.file(`${MIGRATIONS}/${file}`).text());
  }
  // The job queue schema belongs to the installed graphile-worker.
  hash.update(await Bun.file("node_modules/graphile-worker/package.json").text());
  return hash.digest("hex").slice(0, 16);
};

const databases = async (prefix: string) =>
  (await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE ${`${prefix}%`}`).map(
    (row) => row.datname,
  );

const buildTemplate = async (name: string) => {
  // Built under a scratch name and renamed, so a crash mid-build never
  // leaves a half-migrated template that later runs would trust.
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
  // CREATE DATABASE … TEMPLATE and RENAME both need the database idle.
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
  // One builder at a time across concurrent `bun test` runs.
  await admin`SELECT pg_advisory_lock(hashtext('hcai_test_template'))`;
  try {
    const existing = await databases(TEMPLATE_PREFIX);
    if (!existing.includes(template)) await buildTemplate(template);
    for (const stale of existing.filter((name) => name !== template && !name.endsWith("_wip"))) {
      // A run on another checkout may still be cloning it; leave it if so.
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

/**
 * Rows every test file starts without. Graphile's own bookkeeping
 * (migrations, task names, crontab state) is schema, not data, and stays.
 */
const resetTables = async (sql: postgres.Sql) => {
  const tables = await sql<{ name: string }[]>`
    SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
    WHERE (schemaname = 'public' AND tablename <> 'schema_migrations')
       OR (schemaname = 'graphile_worker' AND tablename IN ('_private_jobs', '_private_job_queues'))
  `;
  // DELETE, not TRUNCATE: TRUNCATE creates new relation files and fsyncs
  // them, about 0.5 s a file on Docker Desktop; DELETE of a few rows is ~40 ms.
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

/**
 * This run's ClickHouse database, migrated by the real runner. ClickHouse
 * has no template databases, but its one migration is a single CREATE, so
 * migrating per run is as cheap as cloning would be.
 */
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

/**
 * Checks both servers, builds the PostgreSQL template if needed, and
 * creates this run's databases (one name, on both servers), once per
 * process. The preload awaits it and drops them when the run ends. Cloning
 * takes about a second on Docker Desktop, so it happens once per run, not
 * once per file.
 */
export const prepareTestDatabases = () =>
  (run ??= prepare().then(async (template) => {
    const name = newDatabaseName();
    await admin`CREATE DATABASE ${admin(name)} TEMPLATE ${admin(template)}`;
    await prepareClickHouse(name, urlFor(name));
    return name;
  }));

/** Drops this run's databases. Registered by the preload. */
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

/**
 * An empty, migrated database for the calling test file. Call it at the top
 * level: `const { sql } = await testDatabase()`. Files run one after
 * another in a `bun test` process and each starts by clearing every row, so
 * a file sees only what it wrote. The connection pool closes after the
 * file's last test.
 *
 * `empty: true` gives a database with no schema at all, for tests of the
 * migration runner itself; it is created for the file and dropped after it.
 */
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
  /** Connection settings for this run's database, for code that builds its own client. */
  config: { url: string; username: string; password: string; database: string };
};

/**
 * This run's migrated ClickHouse database for the calling test file, with
 * every table emptied first (TRUNCATE is cheap in ClickHouse). Call it at
 * the top level, like `testDatabase()`. The client closes after the file.
 */
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

const redact = (value: string) => {
  try {
    const parsed = new URL(value);
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return "<unparseable url>";
  }
};
