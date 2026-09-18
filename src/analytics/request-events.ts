import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import type postgres from "postgres";

import type { JsonValue } from "../billing/engine";

export type RequestEventPayload = Record<string, JsonValue>;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const stringValue = (value: JsonValue | undefined, fallback = "") =>
  typeof value === "string" ? value : fallback;

const numberValue = (value: JsonValue | undefined, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const booleanValue = (value: JsonValue | undefined) => value === true;

const nullableString = (value: JsonValue | undefined) =>
  typeof value === "string" && value.length > 0 ? value : null;

const mapValue = (value: JsonValue | undefined): Record<string, string> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item]] : [],
    ),
  );
};

const clickHouseTimestamp = (value: JsonValue | undefined) => {
  const parsed =
    typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return date.toISOString().replace("T", " ").replace("Z", "");
};

/**
 * Maps the finalization payload written by BillingEngine.finalize onto the
 * hcai.request_events row. Unknown or malformed fields degrade to neutral
 * values rather than failing delivery, so one odd event cannot block the
 * queue.
 */
export const toClickHouseEvent = (payload: RequestEventPayload) => {
  const eventId = stringValue(payload.event_id);
  if (!eventId) throw new TypeError("request event payload has no event_id");

  return {
    event_id: eventId,
    event_version: 1,
    occurred_at: clickHouseTimestamp(payload.occurred_at),
    request_id: stringValue(payload.request_id, NIL_UUID),
    reservation_id: nullableString(payload.reservation_id),
    account_id: stringValue(payload.account_id, NIL_UUID),
    user_id: nullableString(payload.user_id),
    api_key_id: nullableString(payload.api_key_id),

    provider: stringValue(payload.provider),
    provider_request_id: stringValue(payload.provider_request_id),
    endpoint: stringValue(payload.endpoint),
    model: stringValue(payload.model),
    outcome: stringValue(payload.outcome, "completed"),
    error_code: stringValue(payload.error_code),
    http_status: numberValue(payload.http_status),
    streamed: booleanValue(payload.streamed),

    duration_ms: numberValue(payload.duration_ms),
    time_to_first_byte_ms:
      typeof payload.time_to_first_byte_ms === "number"
        ? payload.time_to_first_byte_ms
        : null,
    input_tokens: numberValue(payload.input_tokens),
    output_tokens: numberValue(payload.output_tokens),
    estimated_cost_usd: stringValue(payload.estimated_cost_usd, "0"),
    provider_cost_usd: nullableString(payload.provider_cost_usd),
    billed_cost_usd: stringValue(payload.billed_cost_usd, "0"),
    usage_source: stringValue(payload.usage_source),

    request_headers: mapValue(payload.request_headers),
    response_headers: mapValue(payload.response_headers),
    attributes: mapValue(payload.attributes),
    request_body: stringValue(payload.request_body),
    response_body: stringValue(payload.response_body),
  };
};

/**
 * Rows that reach this many attempts stay in the outbox for inspection.
 * Every failed hand-off to ClickHouse counts, so a persistently failing
 * batch is eventually parked. A short outage costs at most a few attempts
 * out of 25 because the loop backs off to a minute between passes.
 */
export const MAX_DELIVERY_ATTEMPTS = 25;

/** Longest pause between passes while ClickHouse keeps failing. */
const MAX_BACKOFF_MS = 60_000;

/** A single-row batch that fails this many times in a row is parked regardless of error class. */
export const POISON_ROW_FAILURES = 5;

export type DrainOptions = {
  sql: postgres.Sql;
  clickhouse: ClickHouseClient;
  /** Rows taken per pass. */
  batchSize?: number;
};

type OutboxRow = { id: string; payload: RequestEventPayload };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A claim older than this is treated as abandoned and the row is retried. */
export const CLAIM_LEASE_MS = 5 * 60 * 1_000;

/**
 * Delivers one batch of finalized request events from request_event_outbox
 * to ClickHouse and returns how many rows it took. Three short statements:
 * claim rows by stamping claimed_at (SKIP LOCKED so drainers never contend),
 * insert into ClickHouse with no Postgres transaction open, then delete the
 * delivered ids. A crash between insert and delete leaves the claim to expire
 * and the batch is redelivered, which ReplacingMergeTree collapses by
 * event_id. Any failure after the batch was handed to the ClickHouse client
 * counts against every row's attempt budget; a payload that cannot be mapped
 * at all is parked immediately.
 */
export const drainRequestEvents = async ({
  sql,
  clickhouse,
  batchSize = 500,
}: DrainOptions): Promise<number> => {
  const rows = await sql<OutboxRow[]>`
    UPDATE request_event_outbox
    SET claimed_at = now()
    WHERE id IN (
      SELECT id
      FROM request_event_outbox
      WHERE
        attempts < ${MAX_DELIVERY_ATTEMPTS}
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${CLAIM_LEASE_MS / 1_000}))
      ORDER BY attempts, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id::text, payload
  `;
  if (rows.length === 0) return 0;

  const delivered: string[] = [];
  const unmappable: string[] = [];
  const unmappableErrors: string[] = [];
  const events: ReturnType<typeof toClickHouseEvent>[] = [];
  for (const row of rows) {
    try {
      events.push(toClickHouseEvent(row.payload));
      delivered.push(row.id);
    } catch (error) {
      unmappable.push(row.id);
      unmappableErrors.push(errorMessage(error));
    }
  }

  if (unmappable.length > 0) {
    // One statement: unnest pairs ids with their errors.
    await sql`
      UPDATE request_event_outbox AS outbox
      SET attempts = ${MAX_DELIVERY_ATTEMPTS}, last_error = parked.error, claimed_at = NULL
      FROM unnest(${unmappable}::bigint[], ${unmappableErrors}::text[]) AS parked(id, error)
      WHERE outbox.id = parked.id
    `;
  }

  if (events.length > 0) {
    try {
      await clickhouse.insert({
        table: "hcai.request_events",
        values: events,
        format: "JSONEachRow",
      });
    } catch (error) {
      await sql`
        UPDATE request_event_outbox
        SET attempts = attempts + 1, last_error = ${errorMessage(error)}, claimed_at = NULL
        WHERE id = ANY(${delivered}::bigint[])
      `;
      throw error;
    }
    await sql`
      DELETE FROM request_event_outbox
      WHERE id = ANY(${delivered}::bigint[])
    `;
  }
  return rows.length;
};

/** Whether ClickHouse itself refused the batch, as opposed to being unreachable. */
export const isClickHouseRejection = (error: unknown) => error instanceof ClickHouseError;

/**
 * Parks the next row the drainer would pick, after a batch of one failed
 * repeatedly: whatever the error class, that row is not going to deliver.
 */
const parkNextRow = async (sql: postgres.Sql, error: string) => {
  await sql`
    UPDATE request_event_outbox
    SET attempts = ${MAX_DELIVERY_ATTEMPTS}, last_error = ${`parked after repeated failures: ${error}`}, claimed_at = NULL
    WHERE id = (
      SELECT id FROM request_event_outbox
      WHERE attempts < ${MAX_DELIVERY_ATTEMPTS}
      ORDER BY attempts, id
      LIMIT 1
    )
  `;
};

export type DrainerOptions = DrainOptions & {
  /** Pause between passes once the outbox is empty. */
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type RequestEventDrainer = { stop: () => Promise<void> };

/**
 * Runs drainRequestEvents continuously: back to back while a backlog
 * exists, then once per interval. Consecutive failures back off
 * exponentially (up to a minute); after the first failure (which keeps the
 * full batch, since an outage should not shrink throughput) any repeated
 * failure halves the batch, until a single poison row is isolated and, after
 * POISON_ROW_FAILURES in a row, parked regardless of error class. `stop`
 * resolves after the pass in flight finishes.
 */
export const startRequestEventDrainer = (
  options: DrainerOptions,
): RequestEventDrainer => {
  const intervalMs = options.intervalMs ?? 1_000;
  const batchSize = options.batchSize ?? 500;
  let stopped = false;
  let wake = () => {};

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, ms);
    });

  const loop = (async () => {
    let failures = 0;
    let currentBatch = batchSize;
    while (!stopped) {
      let taken = 0;
      try {
        taken = await drainRequestEvents({ ...options, batchSize: currentBatch });
        failures = 0;
        currentBatch = batchSize;
      } catch (error) {
        failures += 1;
        if (failures > 1) {
          currentBatch = Math.max(1, Math.floor(currentBatch / 2));
        }
        if (currentBatch === 1 && failures >= POISON_ROW_FAILURES) {
          await parkNextRow(options.sql, errorMessage(error)).catch(options.onError);
          failures = 0;
        }
        options.onError?.(error);
      }
      if (stopped) break;
      if (failures > 0) {
        await sleep(Math.min(intervalMs * 2 ** (failures - 1), MAX_BACKOFF_MS));
      } else if (taken < currentBatch) {
        await sleep(intervalMs);
      }
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      wake();
      await loop;
    },
  };
};

/** Parked rows older than this lose their request and response bodies. */
export const PARKED_BODY_RETENTION_DAYS = 7;

/**
 * Strips prompt and completion bodies from rows that will never be
 * delivered, so a parked row does not keep them past the 90-day ClickHouse
 * TTL. Identifiers, headers, and last_error stay for inspection. Returns
 * how many rows were stripped.
 */
export const stripParkedBodies = async (sql: postgres.Sql): Promise<number> => {
  const rows = await sql<{ id: string }[]>`
    UPDATE request_event_outbox
    SET payload = payload - 'request_body' - 'response_body'
    WHERE
      attempts >= ${MAX_DELIVERY_ATTEMPTS}
      AND created_at < now() - make_interval(days => ${PARKED_BODY_RETENTION_DAYS})
      AND (payload ? 'request_body' OR payload ? 'response_body')
    RETURNING id::text
  `;
  return rows.length;
};
