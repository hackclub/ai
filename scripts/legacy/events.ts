import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

import { toClickHouseEvent } from "../../src/analytics/request-event";
import { redactHeaders } from "../../src/gateway/metered-request";
import { EXA } from "../../src/providers/exa/provider";
import { MISTRAL } from "../../src/providers/mistral/provider";
import { OPENROUTER } from "../../src/providers/openrouter/provider";
import { TYPESAFE } from "../../src/providers/typesafe/provider";

type Sql = postgres.Sql;

/**
 * Copies the previous gateway's `request_logs` into ClickHouse
 * `request_events`, one UTC day at a time. Run it after `importIdentity`:
 * rows are attributed through the user's Slack ID.
 *
 * Re-running a day is harmless: `event_id` is the legacy row id, so
 * ReplacingMergeTree collapses duplicates. Bodies are copied only for rows
 * at or after `bodiesSince`; older ones would be removed by the table's
 * body TTL anyway, and skipping them keeps PostgreSQL from reading TOAST.
 */
export type EventImportOptions = {
  from: Date;
  /** Exclusive. */
  to: Date;
  bodiesSince: Date;
  /** Days imported at once, each on its own cursor; `legacy` needs a pool at least this large. */
  concurrency?: number;
  onDay?: (day: Date, rows: number) => void;
};

type LegacyLog = {
  id: string;
  api_key_id: string;
  slack_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost: string;
  ip: string;
  occurred_at: Date;
  duration: number;
  headers: Record<string, string> | null;
  request: string;
  response: string;
};

const CURSOR_ROWS = 100;
/**
 * The client serialises an insert into one string, and legacy bodies average
 * about 1 MB on busy days, so batches are bounded by body size, not rows.
 */
const MAX_BATCH_CHARS = 32 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The legacy gateway logged no provider; its model names identify the non-OpenRouter ones. */
export const legacyProvider = (model: string) => {
  if (model.startsWith("exa")) return EXA;
  if (model.startsWith("mistral-ocr")) return MISTRAL;
  if (model.startsWith("jev")) return TYPESAFE;
  return OPENROUTER;
};

const utcDay = (date: Date) => new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);

/**
 * `legacy` must use TimeZone=UTC so that comparing `timestamp without time
 * zone` columns to the day bounds is a comparison in UTC.
 */
export async function importEvents(
  legacy: Sql,
  target: Sql,
  clickhouse: ClickHouseClient,
  options: EventImportOptions,
): Promise<{ rows: number; unattributed: number }> {
  const owners = new Map(
    (
      await target<{ slack_id: string; user_id: string; account_id: string }[]>`
        SELECT u.slack_id, u.id AS user_id, a.id AS account_id
        FROM users u
        JOIN billing_accounts a ON a.owner_type = 'user' AND a.owner_id = u.id
      `
    ).map((row) => [row.slack_id, row]),
  );

  let rows = 0;
  let unattributed = 0;
  const days: Date[] = [];
  for (let day = utcDay(options.from); day < options.to; day = new Date(day.getTime() + DAY_MS)) days.push(day);

  const importDay = async (day: Date) => {
    const end = new Date(Math.min(day.getTime() + DAY_MS, options.to.getTime()));
    let dayRows = 0;
    const cursor = legacy<LegacyLog[]>`
      SELECT
        id, api_key_id, slack_id, model, prompt_tokens, completion_tokens,
        cost::text AS cost, ip, duration, headers,
        timestamp AT TIME ZONE 'UTC' AS occurred_at,
        CASE WHEN timestamp >= ${options.bodiesSince} THEN request ELSE '' END AS request,
        CASE WHEN timestamp >= ${options.bodiesSince} THEN response ELSE '' END AS response
      FROM request_logs
      WHERE timestamp >= ${day} AND timestamp < ${end}
    `.cursor(CURSOR_ROWS);

    let values: ReturnType<typeof toClickHouseEvent>[] = [];
    let chars = 0;
    const flush = async () => {
      if (values.length === 0) return;
      await clickhouse.insert({ table: "request_events", values, format: "JSONEachRow" });
      dayRows += values.length;
      values = [];
      chars = 0;
    };

    for await (const batch of cursor) {
      for (const log of batch) {
        const owner = owners.get(log.slack_id);
        if (!owner) unattributed++;
        const withBody = log.occurred_at >= options.bodiesSince;
        values.push(
          toClickHouseEvent({
            event_id: log.id,
            occurred_at: log.occurred_at.toISOString(),
            request_id: log.id,
            reservation_id: null,
            // Logs of users since deleted keep the nil account so totals still add up.
            account_id: owner?.account_id ?? NIL_UUID,
            user_id: owner?.user_id ?? null,
            api_key_id: log.api_key_id,
            provider: legacyProvider(log.model),
            provider_request_id: "",
            endpoint: "",
            model: log.model,
            outcome: "completed",
            error_code: "",
            http_status: 200,
            streamed: false,
            duration_ms: log.duration,
            time_to_first_byte_ms: null,
            input_tokens: log.prompt_tokens,
            output_tokens: log.completion_tokens,
            estimated_cost_usd: log.cost,
            provider_cost_usd: log.cost,
            billed_cost_usd: log.cost,
            unfunded_cost_usd: "0",
            usage_source: "legacy",
            request_headers: redactHeaders(log.headers ?? undefined),
            response_headers: {},
            attributes: { ip: log.ip, source: "legacy", body_capture: withBody ? "complete" : "none" },
            request_body: log.request,
            response_body: log.response,
          }),
        );
        chars += log.request.length + log.response.length;
        if (chars >= MAX_BATCH_CHARS) await flush();
      }
    }
    await flush();
    rows += dayRows;
    options.onDay?.(day, dayRows);
  };

  // Each worker takes the next day off the queue until none remain.
  const queue = days.values();
  const worker = async () => {
    for (const day of queue) await importDay(day);
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
  return { rows, unattributed };
}
