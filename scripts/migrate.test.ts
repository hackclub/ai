import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { $ } from "bun";

import { pendingPostgresMigrations } from "../src/migrations";
import { testDatabase } from "../src/test/database";

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

const { sql, url: scratchUrl } = await testDatabase({ empty: true });

describe("bun run db:migrate against a scratch database", () => {
  const migrate = () =>
    $`bun scripts/migrate.ts --only=postgres`.env({ ...process.env, DATABASE_URL: scratchUrl }).quiet();

  test("converts the old runner's versions, applies the rest, then nothing", async () => {
    const files = await migrationFiles("postgres");
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
  });
});
