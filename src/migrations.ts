/**
 * Shared pieces for the versioned migration runner (`scripts/migrate.ts`)
 * and the server's startup pending-migrations warning.
 *
 * ClickHouse has no transactional DDL: a failure partway through a
 * multi-statement ClickHouse migration file leaves earlier statements
 * applied. Every ClickHouse migration must therefore be written
 * idempotently (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, ...).
 */
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { readdir, readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";

export type LogFn = (message: string) => void;

const defaultLog: LogFn = (message) => console.log(message);

/** Lists `.sql` files in `dir`, sorted by filename. */
export const listMigrationFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

/**
 * Splits ClickHouse migration file contents into individual statements.
 * Strips `--` line comments, then splits on `;` followed by a newline or
 * end of file, dropping empty statements.
 *
 * Known limitation: a `;` inside a string literal is not handled specially
 * (none of the current migrations need it).
 */
export const splitClickHouseStatements = (text: string): string[] => {
  const withoutComments = text
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
  return withoutComments
    .split(/;(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
};

/**
 * Sentinel that proves a given migration file was already applied by Docker's
 * initdb bootstrap: a Postgres table, or `table.column` for a file that only
 * adds a column (`db.table` for ClickHouse). Files that are idempotent need
 * no entry; they are simply applied again.
 */
export const POSTGRES_BOOTSTRAP_SENTINELS: Record<string, string> = {
  "0001_billing.sql": "billing_reservations",
  "0002_identity.sql": "users",
  "0003_sessions.sql": "sessions",
  "0004_replicate_resources.sql": "replicate_resources",
  "0005_request_event_outbox.sql": "request_event_outbox",
  "0006_request_event_outbox_claims.sql": "request_event_outbox.claimed_at",
};

export const CLICKHOUSE_BOOTSTRAP_SENTINELS: Record<string, string> = {
  "0001_request_events.sql": "hcai.request_events",
};

const ensurePostgresMigrationsTable = (sql: Sql) =>
  sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

/** Versions already recorded in `schema_migrations`, or `[]` if the table does not exist yet. */
export const appliedVersions = async (sql: Sql): Promise<string[]> => {
  const exists = await sql<{ to_regclass: string | null }[]>`
    SELECT to_regclass('public.schema_migrations') AS to_regclass
  `;
  if (exists[0]?.to_regclass === null) return [];
  const rows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
  return rows.map((row) => row.version);
};

/**
 * Files in `migrations/postgres` not yet recorded in `schema_migrations`.
 * Returns `[]` without throwing when `schema_migrations` does not exist
 * (a not-yet-migrated store), so the server's startup check never fails
 * because of this.
 */
export const pendingPostgresMigrations = async (
  sql: Sql,
  dir = "migrations/postgres",
): Promise<string[]> => {
  try {
    const [files, applied] = await Promise.all([listMigrationFiles(dir), appliedVersions(sql)]);
    const appliedSet = new Set(applied);
    return files.filter((file) => !appliedSet.has(file));
  } catch {
    return [];
  }
};

export type MigrateResult = { applied: number; skipped: number };

/**
 * Applies unapplied SQL files from `migrations/postgres` (or a caller-supplied
 * dir, for tests) against `databaseUrl`, in filename order, recording each
 * one in `schema_migrations`. Bootstraps a database that Docker's initdb
 * already populated (the tables exist but no `schema_migrations` rows do) by
 * recording each file whose sentinel table exists as applied, without
 * running it. Opens and closes its own connection to `databaseUrl`.
 */
export const migratePostgres = async (
  databaseUrl: string,
  opts: { dir?: string; log?: LogFn } = {},
): Promise<MigrateResult> => {
  const sql = postgres(databaseUrl, { max: 4 });
  try {
    return await migratePostgresWithSql(sql, opts);
  } finally {
    await sql.end();
  }
};

/**
 * Ensures `schema_migrations` exists and, for every file not yet recorded
 * whose own sentinel table already exists (proof the volume was initialised,
 * fully or partially, by Docker's initdb bootstrap, or that a
 * `schema_migrations` row was lost after a real apply), records it as
 * applied without running it. A file with no known sentinel, or whose
 * sentinel table does not exist, is left pending for a real apply. Never
 * executes migration SQL itself, so `--status` can call this too. Mutates
 * `sql`'s database; safe to call repeatedly.
 */
export const ensurePostgresBootstrap = async (
  sql: Sql,
  dir = "migrations/postgres",
  log: LogFn = defaultLog,
): Promise<void> => {
  await ensurePostgresMigrationsTable(sql);

  const files = await listMigrationFiles(dir);
  const applied = new Set(await appliedVersions(sql));
  const missing = files.filter((file) => !applied.has(file));
  if (missing.length === 0) return;

  let bootstrapped = 0;
  for (const file of missing) {
    const sentinel = POSTGRES_BOOTSTRAP_SENTINELS[file];
    if (!sentinel) continue; // not in the map: applied normally, below.
    const [table, column] = sentinel.split(".");
    const exists = column
      ? await sql`
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table!} AND column_name = ${column}
        `
      : await sql`SELECT 1 WHERE to_regclass(${"public." + table}) IS NOT NULL`;
    if (exists.length === 0) continue;
    await sql`
      INSERT INTO schema_migrations (version)
      VALUES (${file})
      ON CONFLICT (version) DO NOTHING
    `;
    bootstrapped += 1;
  }
  if (bootstrapped > 0) {
    log(`bootstrap: recorded ${bootstrapped} existing postgres migrations`);
  }
};

const migratePostgresWithSql = async (
  sql: Sql,
  { dir = "migrations/postgres", log = defaultLog }: { dir?: string; log?: LogFn } = {},
): Promise<MigrateResult> => {
  await ensurePostgresBootstrap(sql, dir, log);

  const files = await listMigrationFiles(dir);
  const applied = new Set(await appliedVersions(sql));

  let appliedCount = 0;
  let skippedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      skippedCount += 1;
      continue;
    }
    const contents = await readFile(`${dir}/${file}`, "utf8");
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('schema_migrations'))`;
      const stillPending = await tx<{ version: string }[]>`
        SELECT version FROM schema_migrations WHERE version = ${file}
      `;
      if (stillPending.length > 0) return;
      await tx.unsafe(contents);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
    applied.add(file);
    appliedCount += 1;
    log(`applied migrations/postgres/${file}`);
  }

  return { applied: appliedCount, skipped: skippedCount };
};

const ensureClickHouseMigrationsTable = async (client: ClickHouseClient) => {
  await client.command({ query: "CREATE DATABASE IF NOT EXISTS hcai" });
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS hcai.schema_migrations (
      version String,
      applied_at DateTime DEFAULT now()
    ) ENGINE = MergeTree ORDER BY version`,
  });
};

const clickhouseAppliedVersions = async (client: ClickHouseClient): Promise<string[]> => {
  const result = await client.query({
    query: "SELECT version FROM hcai.schema_migrations",
    format: "JSONEachRow",
  });
  const rows = await result.json<{ version: string }>();
  return rows.map((row) => row.version);
};

const clickhouseTableExists = async (client: ClickHouseClient, table: string): Promise<boolean> => {
  const result = await client.query({
    query: `EXISTS TABLE ${table}`,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ result: number }>();
  return rows[0]?.result === 1;
};

/**
 * Applies unapplied SQL files from `migrations/clickhouse` (or a
 * caller-supplied dir) against a ClickHouse server at `url`, recording each
 * one in `hcai.schema_migrations`. Bootstraps a database that Docker's
 * initdb already populated the same way `migratePostgres` does. Opens and
 * closes its own client.
 */
export const migrateClickHouse = async (
  url: string,
  username: string,
  password: string,
  opts: { dir?: string; log?: LogFn } = {},
): Promise<MigrateResult> => {
  const client = createClient({ url, username, password });
  try {
    return await migrateClickHouseWithClient(client, opts);
  } finally {
    await client.close();
  }
};

/**
 * Ensures `hcai.schema_migrations` exists and, if it is empty, records every
 * file whose own sentinel table exists as applied without running it. Never
 * executes migration SQL, so `--status` can call this too. Mutates the
 * database at `client`; safe to call repeatedly.
 */
export const ensureClickHouseBootstrap = async (
  client: ClickHouseClient,
  dir = "migrations/clickhouse",
  log: LogFn = defaultLog,
): Promise<void> => {
  await ensureClickHouseMigrationsTable(client);

  const applied = new Set(await clickhouseAppliedVersions(client));
  if (applied.size !== 0) return;

  const files = await listMigrationFiles(dir);
  let bootstrapped = 0;
  for (const file of files) {
    const sentinel = CLICKHOUSE_BOOTSTRAP_SENTINELS[file];
    if (!sentinel) continue;
    if (!(await clickhouseTableExists(client, sentinel))) continue;
    await client.command({
      query: `INSERT INTO hcai.schema_migrations (version) VALUES ({version:String})`,
      query_params: { version: file },
    });
    bootstrapped += 1;
  }
  if (bootstrapped > 0) {
    log(`bootstrap: recorded ${bootstrapped} existing clickhouse migrations`);
  }
};

const migrateClickHouseWithClient = async (
  client: ClickHouseClient,
  { dir = "migrations/clickhouse", log = defaultLog }: { dir?: string; log?: LogFn } = {},
): Promise<MigrateResult> => {
  await ensureClickHouseBootstrap(client, dir, log);

  const files = await listMigrationFiles(dir);
  const applied = new Set(await clickhouseAppliedVersions(client));

  let appliedCount = 0;
  let skippedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      skippedCount += 1;
      continue;
    }
    const contents = await readFile(`${dir}/${file}`, "utf8");
    const statements = splitClickHouseStatements(contents);
    for (const statement of statements) {
      await client.command({ query: statement });
    }
    await client.command({
      query: `INSERT INTO hcai.schema_migrations (version) VALUES ({version:String})`,
      query_params: { version: file },
    });
    applied.add(file);
    appliedCount += 1;
    log(`applied migrations/clickhouse/${file}`);
  }

  return { applied: appliedCount, skipped: skippedCount };
};
