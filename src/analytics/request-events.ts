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
 * Rows ClickHouse rejected this many times stay in the outbox for
 * inspection. Only rejections count: a failure to reach ClickHouse at all
 * says nothing about the rows, so an outage never parks them.
 */
export const MAX_DELIVERY_ATTEMPTS = 25;

/** Longest pause between passes while ClickHouse keeps failing. */
const MAX_BACKOFF_MS = 60_000;

export type DrainOptions = {
  sql: postgres.Sql;
  clickhouse: ClickHouseClient;
  /** Rows taken per pass. */
  batchSize?: number;
};

type OutboxRow = { id: string; payload: RequestEventPayload };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Delivers one batch of finalized request events from request_event_outbox
 * to ClickHouse and returns how many rows it took. Rows are locked with SKIP
 * LOCKED, so several drainers can run at once, and deleted in the same
 * transaction as the insert: a crash after the insert redelivers the batch,
 * which ReplacingMergeTree collapses by event_id. A batch ClickHouse rejects
 * is released with its attempt count raised and sinks behind fresh rows; a
 * batch that never reached ClickHouse is released with only the error
 * recorded; a payload that cannot be mapped at all is parked immediately.
 */
export const drainRequestEvents = async ({
  sql,
  clickhouse,
  batchSize = 500,
}: DrainOptions): Promise<number> => {
  let taken: string[] = [];
  try {
    return await sql.begin(async (tx) => {
      const rows = await tx<OutboxRow[]>`
        SELECT id::text, payload
        FROM request_event_outbox
        WHERE attempts < ${MAX_DELIVERY_ATTEMPTS}
        ORDER BY attempts, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return 0;
      taken = rows.map((row) => row.id);

      const delivered: string[] = [];
      const unmappable: { id: string; error: string }[] = [];
      const events: ReturnType<typeof toClickHouseEvent>[] = [];
      for (const row of rows) {
        try {
          events.push(toClickHouseEvent(row.payload));
          delivered.push(row.id);
        } catch (error) {
          unmappable.push({ id: row.id, error: errorMessage(error) });
        }
      }

      if (events.length > 0) {
        await clickhouse.insert({
          table: "hcai.request_events",
          values: events,
          format: "JSONEachRow",
        });
        await tx`
          DELETE FROM request_event_outbox
          WHERE id = ANY(${delivered}::bigint[])
        `;
      }
      for (const row of unmappable) {
        await tx`
          UPDATE request_event_outbox
          SET attempts = ${MAX_DELIVERY_ATTEMPTS}, last_error = ${row.error}
          WHERE id = ${row.id}::bigint
        `;
      }
      return rows.length;
    });
  } catch (error) {
    if (taken.length > 0) {
      const rejected = error instanceof ClickHouseError ? 1 : 0;
      await sql`
        UPDATE request_event_outbox
        SET attempts = attempts + ${rejected}, last_error = ${errorMessage(error)}
        WHERE id = ANY(${taken}::bigint[])
      `;
    }
    throw error;
  }
};

/** Whether ClickHouse itself refused the batch, as opposed to being unreachable. */
export const isClickHouseRejection = (error: unknown) => error instanceof ClickHouseError;

export type DrainerOptions = DrainOptions & {
  /** Pause between passes once the outbox is empty. */
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type RequestEventDrainer = { stop: () => Promise<void> };

/**
 * Runs drainRequestEvents continuously: back to back while a backlog
 * exists, then once per interval. Consecutive failures back off
 * exponentially (up to a minute), and a rejected batch is retried at half
 * the size until a single poison row is isolated, so one bad payload
 * cannot drag its neighbours over the attempt limit. `stop` resolves after
 * the pass in flight finishes.
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
        if (isClickHouseRejection(error)) {
          currentBatch = Math.max(1, Math.floor(currentBatch / 2));
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
