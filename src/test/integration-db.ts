import { test } from "bun:test";

/**
 * Resolves the opt-in integration database for a test file. Returns null
 * (and the file's tests skip) when the variable is unset. Throws when the
 * variable points at the same database as DATABASE_URL: the dev server's
 * outbox drainer and reconcile cron would race the assertions, which is
 * exactly the flakiness this guard exists to stop.
 */
export const integrationDatabaseUrl = (variable: "BILLING_TEST_DATABASE_URL" | "ANALYTICS_TEST_DATABASE_URL") => {
  const url = process.env[variable];
  if (!url) return null;
  const dev = process.env.DATABASE_URL;
  if (dev && sameDatabase(url, dev)) {
    throw new Error(
      `${variable} points at the dev database (${redact(url)}). Use a separate database, e.g. ` +
        "postgres://hcai:hcai@localhost:55432/hcai_test; see README \"Integration tests\".",
    );
  }
  return url;
};

/** The ClickHouse URL for the delivery test, or null to skip. */
export const integrationClickHouseUrl = () => process.env.ANALYTICS_TEST_CLICKHOUSE_URL ?? null;

/** `test` when the database is configured, `test.skip` otherwise. */
export const integrationTestFor = (...urls: (string | null)[]) =>
  urls.every((url) => url !== null) ? test : test.skip;

const sameDatabase = (left: string, right: string) => {
  const normalize = (value: string) => {
    const parsed = new URL(value);
    const host = parsed.hostname === "127.0.0.1" ? "localhost" : parsed.hostname;
    return `${host}:${parsed.port || "5432"}${parsed.pathname}`;
  };
  try {
    return normalize(left) === normalize(right);
  } catch {
    return left === right;
  }
};

const redact = (value: string) => {
  try {
    const parsed = new URL(value);
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return "<unparseable url>";
  }
};
