import type { JsonValue, UsageSource } from "../billing/engine";
import type { Usd } from "../billing/money";

/**
 * The analytics request event: one row of ClickHouse `request_events`.
 *
 * Two halves make an event. The caller that saw the request (the gateway, or
 * the reconciler for a request settled from the provider's own record)
 * supplies the observation; the billing engine supplies the settlement inside
 * the finalize transaction, reading identity from the reservation row. The
 * engine writes `outboxPayload(observation, settlement)` to the outbox and the
 * drainer maps it with `toClickHouseEvent`.
 */

export type RequestOutcome = "completed" | "provider_error" | "reconciled";
export type BodyCapture = "complete" | "partial" | "truncated" | "none";

/** What the caller observed. Filled by the gateway or by reconciliation. */
export type RequestObservation = {
  endpoint: string;
  model: string;
  outcome: RequestOutcome;
  errorCode: string;
  httpStatus: number;
  streamed: boolean;
  durationMs: number;
  timeToFirstByteMs: number | null;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: Usd | null;
  /** Already redacted (redactHeaders). */
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  attributes: Record<string, string>;
  requestBody: string;
  responseBody: string;
};

/** What the engine knows inside the finalize transaction. */
export type RequestSettlement = {
  eventId: string;
  occurredAt: Date;
  requestId: string;
  reservationId: string;
  accountId: string;
  userId: string | null;
  apiKeyId: string | null;
  provider: string;
  providerRequestId: string | null;
  estimatedCostUsd: Usd;
  billedCostUsd: Usd;
  unfundedCostUsd: Usd;
  usageSource: UsageSource;
};

/**
 * The outbox payload. Keys are the ClickHouse column names; the drainer,
 * `stripParkedBodies` (`request_body`, `response_body`) and tests read them.
 */
export type OutboxPayload = { [column: string]: JsonValue };

export const outboxPayload = (o: RequestObservation, s: RequestSettlement): OutboxPayload => ({
  event_id: s.eventId,
  occurred_at: s.occurredAt.toISOString(),
  request_id: s.requestId,
  reservation_id: s.reservationId,
  account_id: s.accountId,
  user_id: s.userId,
  api_key_id: s.apiKeyId,

  provider: s.provider,
  provider_request_id: s.providerRequestId,
  endpoint: o.endpoint,
  model: o.model,
  outcome: o.outcome,
  error_code: o.errorCode,
  http_status: o.httpStatus,
  streamed: o.streamed,

  duration_ms: o.durationMs,
  time_to_first_byte_ms: o.timeToFirstByteMs,
  input_tokens: o.inputTokens,
  output_tokens: o.outputTokens,
  estimated_cost_usd: s.estimatedCostUsd.toString(),
  provider_cost_usd: o.providerCostUsd ? o.providerCostUsd.toString() : null,
  billed_cost_usd: s.billedCostUsd.toString(),
  unfunded_cost_usd: s.unfundedCostUsd.toString(),
  usage_source: s.usageSource,

  request_headers: o.requestHeaders,
  response_headers: o.responseHeaders,
  attributes: o.attributes,
  request_body: o.requestBody,
  response_body: o.responseBody,
});

/**
 * The observation for a reservation settled from the provider's own record.
 * Nothing about the original HTTP exchange survives, so only the charge and
 * the endpoint recorded at reserve are known.
 */
export const reconciledObservation = (
  charge: { model: string; inputTokens: number; outputTokens: number; costUsd: Usd },
  reservation: { endpoint: string | null; reconciliationReason: string | null },
): RequestObservation => ({
  endpoint: reservation.endpoint ?? "",
  model: charge.model,
  outcome: "reconciled",
  errorCode: "",
  httpStatus: 0,
  streamed: false,
  durationMs: 0,
  timeToFirstByteMs: null,
  inputTokens: charge.inputTokens,
  outputTokens: charge.outputTokens,
  providerCostUsd: charge.costUsd,
  requestHeaders: {},
  responseHeaders: {},
  attributes: { body_capture: "none", reconciliation_reason: reservation.reconciliationReason ?? "" },
  requestBody: "",
  responseBody: "",
});

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const stringValue = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

const numberValue = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const booleanValue = (value: unknown) => value === true;

const nullableString = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const mapValue = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (typeof item === "string" ? [[key, item]] : [])),
  );
};

const clickHouseTimestamp = (value: unknown) => {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return date.toISOString().replace("T", " ").replace("Z", "");
};

/**
 * Maps an outbox payload onto a request_events row. The outbox can hold rows
 * written by an older deploy and parked rows, so unknown or malformed fields
 * degrade to neutral values rather than failing delivery; only a payload
 * without an `event_id` throws.
 */
export const toClickHouseEvent = (payload: unknown) => {
  if (!isRecord(payload)) throw new TypeError("request event payload is not an object");
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
    time_to_first_byte_ms: typeof payload.time_to_first_byte_ms === "number" ? payload.time_to_first_byte_ms : null,
    input_tokens: numberValue(payload.input_tokens),
    output_tokens: numberValue(payload.output_tokens),
    estimated_cost_usd: stringValue(payload.estimated_cost_usd, "0"),
    provider_cost_usd: nullableString(payload.provider_cost_usd),
    billed_cost_usd: stringValue(payload.billed_cost_usd, "0"),
    unfunded_cost_usd: stringValue(payload.unfunded_cost_usd, "0"),
    usage_source: stringValue(payload.usage_source),

    request_headers: mapValue(payload.request_headers),
    response_headers: mapValue(payload.response_headers),
    attributes: mapValue(payload.attributes),
    request_body: stringValue(payload.request_body),
    response_body: stringValue(payload.response_body),
  };
};
