/**
 * Applies unapplied SQL files from migrations/postgres and
 * migrations/clickhouse in filename order and records each one.
 *
 *   bun run db:migrate            # apply pending
 *   bun run db:migrate --status   # list applied/pending, apply nothing
 *
 * Bootstrap: a database initialised by Docker's entrypoint has the tables but
 * no schema_migrations row. Such a store is detected by its sentinel table
 * and every existing file is recorded as applied without running it.
 *
 * Reads connection settings directly from process.env (not `loadEnv()`), so
 * this can run as a deploy step without provider API keys present.
 *
 * ClickHouse has no transactional DDL, so every ClickHouse migration must be
 * written idempotently (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, ...); a
 * failure partway through a file leaves earlier statements applied.
 */
import { createClient } from "@clickhouse/client";
import postgres from "postgres";

import {
  appliedVersions,
  ensureClickHouseBootstrap,
  ensurePostgresBootstrap,
  listMigrationFiles,
  migrateClickHouse,
  migratePostgres,
} from "../src/migrations";

const statusOnly = process.argv.includes("--status");
const env = process.env;
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("Missing required environment variable DATABASE_URL");
const clickhouseUrl = env.CLICKHOUSE_URL ?? "http://localhost:8123";
const clickhouseUser = env.CLICKHOUSE_USER ?? "hcai";
const clickhousePassword = env.CLICKHOUSE_PASSWORD ?? "hcai";

const log = (message: string) => console.log(message);

const printStatus = async () => {
  const sql = postgres(databaseUrl, { max: 2 });
  const client = createClient({ url: clickhouseUrl, username: clickhouseUser, password: clickhousePassword });

  let pendingCount = 0;
  try {
    // Never executes migration SQL: only records already-applied files
    // (Docker's initdb bootstrap) so a freshly compose-initialised database
    // reports "applied" instead of "pending" without a prior apply run.
    await ensurePostgresBootstrap(sql, "migrations/postgres", log);
    await ensureClickHouseBootstrap(client, "migrations/clickhouse", log);

    const pgFiles = await listMigrationFiles("migrations/postgres");
    const pgApplied = new Set(await appliedVersions(sql));
    for (const file of pgFiles) {
      if (pgApplied.has(file)) {
        log(`migrations/postgres/${file}: applied`);
      } else {
        log(`migrations/postgres/${file}: pending`);
        pendingCount += 1;
      }
    }

    const chFiles = await listMigrationFiles("migrations/clickhouse");
    const chResult = await client.query({
      query: "SELECT version FROM hcai.schema_migrations",
      format: "JSONEachRow",
    });
    const chRows = await chResult.json<{ version: string }>();
    const chApplied = new Set(chRows.map((row) => row.version));
    for (const file of chFiles) {
      if (chApplied.has(file)) {
        log(`migrations/clickhouse/${file}: applied`);
      } else {
        log(`migrations/clickhouse/${file}: pending`);
        pendingCount += 1;
      }
    }
  } finally {
    await sql.end();
    await client.close();
  }

  if (pendingCount > 0) process.exit(2);
};

if (statusOnly) {
  await printStatus();
} else {
  const pg = await migratePostgres(databaseUrl, { log });
  const ch = await migrateClickHouse(clickhouseUrl, clickhouseUser, clickhousePassword, { log });
  log(
    `postgres: applied ${pg.applied}, skipped ${pg.skipped}; ` +
      `clickhouse: applied ${ch.applied}, skipped ${ch.skipped}`,
  );
}
