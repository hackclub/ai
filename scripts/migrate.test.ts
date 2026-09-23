import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { $ } from "bun";
import postgres, { type Sql } from "postgres";

import { pendingPostgresMigrations } from "../src/migrations";
import { integrationDatabaseUrl, integrationTestFor } from "../src/test/integration-db";

const migrationFiles = async (store: "postgres" | "clickhouse") =>
  (await readdir(`migrations/${store}`)).filter((file) => file.endsWith(".sql")).sort();

describe("migration files", () => {
  test("are numbered and carry dbmate's up and down markers", async () => {
    for (const store of ["postgres", "clickhouse"] as const) {
      for (const file of await migrationFiles(store)) {
        expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
        const text = await Bun.file(`migrations/${store}/${file}`).text();
        expect(text.startsWith("-- migrate:up\n")).toBe(true);
        expect(text).toContain("\n-- migrate:down\n");
      }
    }
  });

  test("hold one statement per ClickHouse file, which ClickHouse requires", async () => {
    for (const file of await migrationFiles("clickhouse")) {
      const text = await Bun.file(`migrations/clickhouse/${file}`).text();
      const code = text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      expect(code.split(";").filter((part) => part.trim().length > 0)).toHaveLength(1);
    }
  });
});

const databaseUrl = integrationDatabaseUrl("BILLING_TEST_DATABASE_URL");
const integrationTest = integrationTestFor(databaseUrl);

describe("bun run db:migrate against a scratch database", () => {
  let adminSql: Sql | undefined;
  let scratchDatabase: string | undefined;
  let scratchUrl: string | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    adminSql = postgres(adminUrl.toString(), { max: 1 });
    scratchDatabase = `migrate_test_${crypto.randomUUID().slice(0, 8)}`;
    await adminSql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    const scratch = new URL(databaseUrl);
    scratch.pathname = `/${scratchDatabase}`;
    scratchUrl = scratch.toString();
  });

  afterAll(async () => {
    if (!adminSql || !scratchDatabase) return;
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await adminSql.end();
  });

  const migrate = () =>
    $`bun scripts/migrate.ts --only=postgres`.env({ ...process.env, DATABASE_URL: scratchUrl! }).quiet();

  integrationTest("converts the old runner's versions, applies the rest, then nothing", async () => {
    if (!scratchUrl) throw new Error("scratch database was not created");
    const files = await migrationFiles("postgres");
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    try {
      // The replaced runner recorded full file names and had applied 0001.
      await sql`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await sql.file(`migrations/postgres/${files[0]}`);
      await sql`INSERT INTO schema_migrations (version) VALUES (${files[0]!})`;

      await migrate();
      const rows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`;
      expect(rows.map((row) => row.version)).toEqual(files.map((file) => file.split("_")[0]!));
      expect(await pendingPostgresMigrations(sql)).toEqual([]);

      const second = await migrate();
      expect(second.stdout.toString()).not.toContain("Applying");
    } finally {
      await sql.end();
    }
  });
});
