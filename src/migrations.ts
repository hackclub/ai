/**
 * The server's startup check for unapplied PostgreSQL migrations. Migrations
 * themselves are applied by dbmate through `bun run db:migrate`
 * (scripts/migrate.ts), which records each file's numeric prefix in
 * `schema_migrations`.
 */
import { readdir } from "node:fs/promises";
import type { Sql } from "postgres";

/** Migration files in `dir` whose version dbmate has not recorded. */
export const pendingPostgresMigrations = async (
  sql: Sql,
  dir = "migrations/postgres",
): Promise<string[]> => {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const applied = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`.catch(
    (error: { code?: string }) => {
      if (error.code === "42P01") return []; // undefined_table: never migrated
      throw error;
    },
  );
  const versions = new Set(applied.map((row) => row.version));
  return files.filter((file) => !versions.has(file.split("_")[0]!));
};
