/**
 * One-off rewrite of bodies stored before the drainer compacted them
 * (src/analytics/bodies.ts): raw SSE responses are assembled and base64 data
 * URLs in either body move to the blob store. Each changed row is reinserted
 * with event_version + 1, which ReplacingMergeTree keeps over the old version.
 *
 *   bun scripts/compact-bodies.ts [--dry-run] [--from=YYYY-MM-DD]
 *
 * Reads CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB
 * and the BLOB_STORE_* variables. Safe to re-run: an event whose newest
 * version is compacted is left alone, and an interrupted run resumes with --from.
 */
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type { S3Client } from "bun";

import { ASSEMBLED_STREAM, compactRows, createBlobStore, uploadBlobs } from "../src/analytics/bodies";

type Row = {
  event_id: string;
  event_version: number;
  occurred_at: string;
  endpoint: string;
  streamed: boolean;
  attributes: Record<string, string>;
  request_body: string;
  response_body: string;
};

const SETTINGS = {
  max_threads: 2,
  max_memory_usage: "4000000000",
  // Decimals must round-trip exactly; UInt64 columns here are small.
  output_format_json_quote_decimals: 1,
  output_format_json_quote_64bit_integers: 0,
} as const;

const PENDING = `(
  (streamed AND attributes['response_body_format'] != '${ASSEMBLED_STREAM}' AND response_body != '')
  OR position(request_body, ';base64,') > 0
  OR position(response_body, ';base64,') > 0
)`;

/** Rows fetched and rewritten together; bodies run up to 20 MiB. */
const PAGE = 50;

export const compactStoredBodies = async ({
  clickhouse,
  blobStore,
  dryRun = false,
  from = "1970-01-01",
  log = console.log,
}: {
  clickhouse: ClickHouseClient;
  blobStore: S3Client;
  dryRun?: boolean;
  from?: string;
  log?: (message: string) => void;
}) => {
  const query = async <T>(sql: string, params: Record<string, unknown> = {}) =>
    (await clickhouse.query({ query: sql, query_params: params, format: "JSONEachRow", clickhouse_settings: SETTINGS })).json<T>();

  const days = await query<{ day: string }>(
    // Bodies only exist inside the 90-day TTL.
    `SELECT DISTINCT toString(toDate(occurred_at)) AS day FROM request_events
     WHERE occurred_at >= greatest(toDateTime({from:Date}), now() - INTERVAL 91 DAY)
     ORDER BY day`,
    { from },
  );

  const totals = { rows: 0, rewritten: 0, blobs: 0, blobBytes: 0, bytesBefore: 0, bytesAfter: 0 };
  for (const { day } of days) {
    const ids = (
      await query<{ event_id: string }>(
        `SELECT DISTINCT event_id FROM request_events WHERE toDate(occurred_at) = {day:Date} AND ${PENDING}`,
        { day },
      )
    ).map((row) => row.event_id);
    const dayTotals = { rewritten: 0, blobs: 0, before: 0, after: 0 };
    for (let start = 0; start < ids.length; start += PAGE) {
      // No FINAL: it reads every column across the key range. Every stored
      // version of the page's events comes back and the newest one wins, so
      // an unmerged older version can never overwrite a compacted one.
      const versions = await query<Row>(
        `SELECT * FROM request_events WHERE toDate(occurred_at) = {day:Date} AND event_id IN {ids:Array(UUID)}`,
        { day, ids: ids.slice(start, start + PAGE) },
      );
      const latest = new Map<string, Row>();
      for (const row of versions) {
        const seen = latest.get(row.event_id);
        if (!seen || row.event_version > seen.event_version) latest.set(row.event_id, row);
      }
      const rows = [...latest.values()];
      const compacted = compactRows(rows);
      const size = (row: Row) => row.request_body.length + row.response_body.length;
      const changed = compacted.rows.filter((row, index) => {
        const original = rows[index]!;
        if (row.request_body === original.request_body && row.response_body === original.response_body) return false;
        dayTotals.before += size(original);
        dayTotals.after += size(row);
        return true;
      });
      if (!dryRun && changed.length > 0) {
        await uploadBlobs(compacted.blobs, blobStore);
        await clickhouse.insert({
          table: "request_events",
          values: changed.map((row) => ({ ...row, event_version: row.event_version + 1 })),
          format: "JSONEachRow",
        });
      }
      totals.rows += rows.length;
      dayTotals.rewritten += changed.length;
      dayTotals.blobs += compacted.blobs.length;
      totals.blobBytes += compacted.blobs.reduce((sum, blob) => sum + blob.bytes.length, 0);
    }
    totals.rewritten += dayTotals.rewritten;
    totals.blobs += dayTotals.blobs;
    totals.bytesBefore += dayTotals.before;
    totals.bytesAfter += dayTotals.after;
    log(`${day}: ${dayTotals.rewritten}/${ids.length} rows, ${dayTotals.before} -> ${dayTotals.after} body bytes, ${dayTotals.blobs} blobs`);
  }
  return totals;
};

if (import.meta.main) {
  const env = process.env;
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const clickhouse = createClient({
    url: required("CLICKHOUSE_URL"),
    username: required("CLICKHOUSE_USER"),
    password: required("CLICKHOUSE_PASSWORD"),
    database: env.CLICKHOUSE_DB ?? "hcai",
    request_timeout: 600_000,
  });
  const blobStore = createBlobStore({
    endpoint: required("BLOB_STORE_URL"),
    bucket: env.BLOB_STORE_BUCKET || "request-blobs",
    region: env.BLOB_STORE_REGION || "garage",
    accessKeyId: required("BLOB_STORE_ACCESS_KEY_ID"),
    secretAccessKey: required("BLOB_STORE_SECRET_ACCESS_KEY"),
  });
  const from = process.argv.find((arg) => arg.startsWith("--from="))?.split("=")[1];
  try {
    console.log(await compactStoredBodies({ clickhouse, blobStore, from, dryRun: process.argv.includes("--dry-run") }));
  } finally {
    await clickhouse.close();
  }
}
