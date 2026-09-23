/**
 * Applies pending migrations in migrations/postgres and migrations/clickhouse
 * with dbmate (https://github.com/amacneil/dbmate).
 *
 *   bun run db:migrate            # apply pending
 *   bun run db:migrate --status   # list applied/pending; exits 2 if any pending
 *   bun run db:migrate --only=postgres   # one store (also --only=clickhouse)
 *
 * This wrapper only does what dbmate cannot: build both URLs from the app's
 * variables, hold a PostgreSQL advisory lock so two deploys never migrate at
 * once, and convert the tracking tables of the runner dbmate replaced.
 *
 * Reads process.env directly (not `loadEnv()`), so it runs as a deploy step
 * without provider API keys. Every file needs `-- migrate:up` and
 * `-- migrate:down` markers, and each ClickHouse file must hold exactly one
 * statement: ClickHouse rejects multi-statement queries.
 */
import { createClient } from "@clickhouse/client";
import { $ } from "bun";
import postgres from "postgres";

const statusOnly = process.argv.includes("--status");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
if (only && only !== "postgres" && only !== "clickhouse") {
  throw new Error(`--only must be postgres or clickhouse, not ${only}`);
}
const stores = (["postgres", "clickhouse"] as const).filter((store) => !only || store === only);
const env = process.env;
if (!env.DATABASE_URL) throw new Error("Missing required environment variable DATABASE_URL");
const clickhouse = {
  url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: env.CLICKHOUSE_USER ?? "hcai",
  password: env.CLICKHOUSE_PASSWORD ?? "hcai",
};

/**
 * dbmate's driver requires TLS unless told otherwise; the app's `postgres`
 * driver does not. Default to the app's behaviour when the URL is silent.
 */
const postgresUrl = (() => {
  const url = new URL(env.DATABASE_URL);
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "disable");
  return url.toString();
})();

/** `http://host:8123` → `clickhouse+http://user:pass@host:8123/hcai`. */
const clickhouseUrl = (() => {
  const url = new URL(clickhouse.url);
  const scheme = url.protocol === "https:" ? "clickhouse+https" : "clickhouse+http";
  const auth = `${encodeURIComponent(clickhouse.username)}:${encodeURIComponent(clickhouse.password)}`;
  return `${scheme}://${auth}@${url.host}/hcai`;
})();

/**
 * One-off conversion from the hand-rolled runner. Postgres kept full file
 * names as versions ("0001_billing.sql"); dbmate keys on the number. The old
 * ClickHouse table had a different shape; its only migration is idempotent,
 * so dropping the table lets dbmate re-apply and record it. Safe to repeat.
 */
const convertLegacyTracking = async (sql: postgres.Sql) => {
  if (stores.includes("postgres")) await convertPostgresTracking(sql);
  if (stores.includes("clickhouse")) await convertClickHouseTracking();
};

const convertPostgresTracking = async (sql: postgres.Sql) => {
  await sql`
    UPDATE schema_migrations SET version = split_part(version, '_', 1)
    WHERE version LIKE '%.sql'
  `.catch((error: { code?: string }) => {
    if (error.code !== "42P01") throw error; // undefined_table: fresh database
  });
};

const convertClickHouseTracking = async () => {
  const client = createClient(clickhouse);
  try {
    const result = await client.query({
      query: `SELECT count() AS legacy FROM system.columns
              WHERE database = 'hcai' AND table = 'schema_migrations' AND name = 'applied_at'`,
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ legacy: string }>();
    if (Number(row?.legacy) > 0) {
      await client.command({ query: "DROP TABLE hcai.schema_migrations" });
    }
  } finally {
    await client.close();
  }
};

// Secrets reach dbmate through its environment, never its argv.
const dbmate = (store: "postgres" | "clickhouse", ...command: string[]) =>
  $`${import.meta.dir}/../node_modules/.bin/dbmate --env MIGRATE_URL --migrations-dir ${`migrations/${store}`} --no-dump-schema ${command}`
    .env({ ...env, MIGRATE_URL: store === "postgres" ? postgresUrl : clickhouseUrl })
    .nothrow();

if (statusOnly) {
  let pending = false;
  for (const store of stores) {
    console.log(`== ${store}`);
    const result = await dbmate(store, "status", "--exit-code");
    pending ||= result.exitCode !== 0;
  }
  process.exit(pending ? 2 : 0);
}

const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  await sql`SELECT pg_advisory_lock(hashtext('schema_migrations'))`;
  await convertLegacyTracking(sql);
  for (const store of stores) {
    const result = await dbmate(store, "up");
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
      break;
    }
  }
} finally {
  await sql.end();
}
