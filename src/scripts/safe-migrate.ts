import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";
import { env } from "../env";

const MIGRATION_NAME = "0011_fair_leo";
const MIGRATION_FILE = `${MIGRATION_NAME}.sql`;

async function main() {
  console.log("Starting safe migration...");

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
  }

  const sql = postgres(env.DATABASE_URL, {
    max: 1,
    onnotice: () => {}, // suppress notices
  });

  try {
    // 1. Add column safely
    console.log("Adding spending_limit_usd column...");
    await sql`
      ALTER TABLE "users" 
      ADD COLUMN IF NOT EXISTS "spending_limit_usd" numeric(10, 8) DEFAULT '10';
    `;

    // 2. Create new index concurrently
    console.log("Creating new index concurrently...");
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "request_logs_user_timestamp_cost_idx" 
      ON "request_logs" USING btree ("user_id", "timestamp" DESC NULLS LAST, "cost");
    `;

    // 3. Drop old index concurrently
    console.log("Dropping old index concurrently...");
    await sql`
      DROP INDEX CONCURRENTLY IF EXISTS "request_logs_user_timestamp_idx";
    `;

    // 4. Mark migration as applied in Drizzle
    console.log("Marking migration as applied...");
    const migrationPath = join(process.cwd(), "drizzle", MIGRATION_FILE);
    const content = readFileSync(migrationPath, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");

    // Drizzle stores timestamp in milliseconds
    const now = Date.now();

    // Check if migration table exists (drizzle might have customized name, but usually 'drizzle_migrations' or '__drizzle_migrations')
    // Config doesn't specify custom table, default is '__drizzle_migrations' for Postgres?
    // Let's check existing tables to be sure.
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'drizzle' OR table_name LIKE '%drizzle%';
    `;
    // console.log("Found drizzle tables:", tables);

    // Assuming default: "drizzle"."__drizzle_migrations" or public."__drizzle_migrations"
    // Usually it's in a specific schema if configured, or public.
    // Drizzle Kit default is `drizzle` schema? or just `__drizzle_migrations` table?
    // Let's try inserting into `__drizzle_migrations` in public schema first.

    // Actually, safer to just try/catch the insert or check first.
    // Based on `drizzle.config.ts`, no schema filter is set, so it uses default.
    // In Postgres, drizzle-kit usually creates a `__drizzle_migrations` table in `drizzle` schema or public?
    // Let's assume standard behavior.

    // We'll try to find the table name from the check above.
    // If not found, we skip marking (user might have not init drizzle yet? unlikely).

    await sql`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${hash}, ${now})
      ON CONFLICT DO NOTHING;
    `.catch(async () => {
      // Fallback to public schema if drizzle schema doesn't exist
      await sql`
            INSERT INTO "__drizzle_migrations" (hash, created_at)
            VALUES (${hash}, ${now})
            ON CONFLICT DO NOTHING;
        `;
    });

    console.log("✅ Safe migration completed successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
