import { $ } from "bun";

/**
 * One command for the Docker-gated suites: start the datastores, create the
 * separate hcai_test database if missing, migrate it, and run bun test with
 * the three opt-in variables set. Extra arguments are passed to bun test.
 */
const PG = "postgres://hcai:hcai@localhost:55432";
const TEST_DB = process.env.INTEGRATION_TEST_DB ?? "hcai_test";
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";

if (process.env.DATABASE_URL?.endsWith(`/${TEST_DB}`)) {
  console.error(`DATABASE_URL points at ${TEST_DB}; the integration tests need a separate database.`);
  process.exit(2);
}

await $`docker compose up -d --wait`;
const exists = (
  await $`docker compose exec -T postgres psql -U hcai -d hcai -tAc ${`SELECT 1 FROM pg_database WHERE datname = '${TEST_DB}'`}`.text()
).trim();
if (exists !== "1") {
  await $`docker compose exec -T postgres psql -U hcai -d hcai -c ${`CREATE DATABASE ${TEST_DB}`}`;
}
await $`bun run db:migrate`.env({
  ...process.env,
  DATABASE_URL: `${PG}/${TEST_DB}`,
  CLICKHOUSE_URL,
  CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? "hcai",
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? "hcai",
});
const args = process.argv.slice(2);
const result = await $`bun test ${args}`
  .env({
    ...process.env,
    BILLING_TEST_DATABASE_URL: `${PG}/${TEST_DB}`,
    ANALYTICS_TEST_DATABASE_URL: `${PG}/${TEST_DB}`,
    ANALYTICS_TEST_CLICKHOUSE_URL: CLICKHOUSE_URL,
  })
  .nothrow();
process.exit(result.exitCode);
