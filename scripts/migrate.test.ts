import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";

import { listMigrationFiles, migratePostgres, splitClickHouseStatements } from "../src/migrations";
import { integrationDatabaseUrl, integrationTestFor } from "../src/test/integration-db";

describe("splitClickHouseStatements", () => {
  test("splits the real clickhouse migration into two statements and drops the trailing comment block", async () => {
    const text = await readFile("migrations/clickhouse/0001_request_events.sql", "utf8");
    const statements = splitClickHouseStatements(text);

    expect(statements).toHaveLength(2);
    expect(statements[0]?.trim().startsWith("CREATE DATABASE")).toBe(true);
    expect(statements[1]?.trim().startsWith("CREATE TABLE")).toBe(true);
    for (const statement of statements) {
      expect(statement.includes("--")).toBe(false);
    }
  });
});

describe("listMigrationFiles", () => {
  test("lists the postgres migrations in filename order", async () => {
    const files = await listMigrationFiles("migrations/postgres");

    expect(files.slice(0, 5)).toEqual([
      "0001_billing.sql",
      "0002_identity.sql",
      "0003_sessions.sql",
      "0004_replicate_resources.sql",
      "0005_request_event_outbox.sql",
    ]);
    for (const file of files) {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
    expect(files).toEqual([...files].sort());
  });
});

const databaseUrl = integrationDatabaseUrl("BILLING_TEST_DATABASE_URL");
const integrationTest = integrationTestFor(databaseUrl);

describe("migratePostgres against a scratch database", () => {
  let adminSql: Sql | undefined;
  let scratchDatabase: string | undefined;
  let scratchUrl: string | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;

    const parsed = new URL(databaseUrl);
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    adminSql = postgres(adminUrl.toString(), { max: 1 });

    scratchDatabase = `migrate_test_${crypto.randomUUID().slice(0, 8)}`;
    await adminSql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);

    const scratch = new URL(parsed);
    scratch.pathname = `/${scratchDatabase}`;
    scratchUrl = scratch.toString();
  });

  afterAll(async () => {
    if (!adminSql || !scratchDatabase) return;
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    await adminSql.end();
  });

  integrationTest("applies all five files, then applies nothing on a second run", async () => {
    if (!scratchUrl) throw new Error("scratch database was not created");

    const first = await migratePostgres(scratchUrl, { log: () => {} });
    expect(first).toEqual({ applied: 5, skipped: 0 });

    const sql = postgres(scratchUrl, { max: 2 });
    try {
      const rows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
      expect(rows).toHaveLength(5);

      const [outbox] = await sql<{ to_regclass: string | null }[]>`
        SELECT to_regclass('public.request_event_outbox') AS to_regclass
      `;
      expect(outbox?.to_regclass).not.toBeNull();
    } finally {
      await sql.end();
    }

    const second = await migratePostgres(scratchUrl, { log: () => {} });
    expect(second).toEqual({ applied: 0, skipped: 5 });
  });
});
