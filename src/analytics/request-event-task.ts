import type { ClickHouseClient } from "@clickhouse/client";
import type { Task } from "graphile-worker";

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
 * Graphile Worker task that delivers one finalized request event to
 * ClickHouse. Delivery is at least once: a job that fails after the insert
 * is retried, and ReplacingMergeTree collapses the duplicate event_id.
 *
 * Jobs arrive one at a time, so the insert asks ClickHouse to batch on the
 * server side (async_insert) instead of creating a part per event.
 */
export const makeRequestEventTask =
  (clickhouse: ClickHouseClient): Task =>
  async (payload) => {
    await clickhouse.insert({
      table: "hcai.request_events",
      values: [toClickHouseEvent(payload as RequestEventPayload)],
      format: "JSONEachRow",
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });
  };
