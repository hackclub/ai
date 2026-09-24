/**
 * One-off import from the previous gateway's database (see scripts/legacy/).
 *
 *   bun scripts/import-legacy.ts identity
 *   bun scripts/import-legacy.ts events --from=2025-11-01 --to=2026-09-25 [--bodies-since=2026-06-26] [--concurrency=4]
 *
 * Reads LEGACY_DATABASE_URL (opened read-only), DATABASE_URL and
 * CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB.
 * `--to` is exclusive; `--bodies-since` defaults to 90 days ago, the
 * request_events body TTL. Both commands are safe to re-run.
 */
import { createClient } from "@clickhouse/client";
import postgres from "postgres";

import { importEvents } from "./legacy/events";
import { importIdentity } from "./legacy/identity";

const env = process.env;
const required = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const date = (name: string, fallback?: Date) => {
  const value = flag(name);
  if (!value) {
    if (fallback) return fallback;
    throw new Error(`--${name}=YYYY-MM-DD is required`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--${name} is not a date: ${value}`);
  return parsed;
};

const command = process.argv[2];
if (command !== "identity" && command !== "events") {
  throw new Error("usage: bun scripts/import-legacy.ts identity | events --from=YYYY-MM-DD --to=YYYY-MM-DD");
}

const concurrency = Number(flag("concurrency") ?? 1);
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

const legacy = postgres(required("LEGACY_DATABASE_URL"), {
  max: concurrency,
  onnotice: () => {},
  connection: { TimeZone: "UTC", default_transaction_read_only: true },
});
const target = postgres(required("DATABASE_URL"), { max: 2, onnotice: () => {} });

try {
  if (command === "identity") {
    console.log(await importIdentity(legacy, target));
  } else {
    const clickhouse = createClient({
      url: required("CLICKHOUSE_URL"),
      username: required("CLICKHOUSE_USER"),
      password: required("CLICKHOUSE_PASSWORD"),
      database: env.CLICKHOUSE_DB ?? "hcai",
      request_timeout: 300_000,
    });
    try {
      const result = await importEvents(legacy, target, clickhouse, {
        from: date("from"),
        to: date("to"),
        bodiesSince: date("bodies-since", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
        concurrency,
        onDay: (day, rows) => console.log(`${day.toISOString().slice(0, 10)} ${rows}`),
      });
      console.log(result);
    } finally {
      await clickhouse.close();
    }
  }
} finally {
  await legacy.end();
  await target.end();
}
