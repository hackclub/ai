import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

import { memoAsync } from "../cache/memo-async";

export type UsageStats = {
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
};

export type ModelUsageStats = UsageStats & { model: string };

export type RecentRequest = {
  requestId: string;
  occurredAt: string;
  model: string;
  endpoint: string;
  outcome: string;
  errorCode: string;
  httpStatus: number;
  inputTokens: number;
  outputTokens: number;
  billedCostUsd: string;
  durationMs: number;
  apiKeyId: string | null;
  ip: string;
};

export type RecentRequestsPage = {
  requests: RecentRequest[];
  /** Cursor for the next page, or null when exhausted. */
  next: { before: string; beforeId: string } | null;
};

const EMPTY: UsageStats = {
  totalRequests: 0,
  totalTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
};

type StatsRow = {
  total_requests: string;
  total_prompt: string;
  total_completion: string;
};

const toStats = (row: StatsRow | undefined): UsageStats => {
  if (!row) return EMPTY;
  const prompt = Number(row.total_prompt);
  const completion = Number(row.total_completion);
  return {
    totalRequests: Number(row.total_requests),
    totalTokens: prompt + completion,
    totalPromptTokens: prompt,
    totalCompletionTokens: completion,
  };
};

export type AnalyticsQueriesOptions = {
  /** How long a global aggregate is served from memory. Default 60 s. */
  globalCacheTtlMs?: number;
  /** Cap on memoized entries (per-account keys included). Default 5,000. */
  memoMaxEntries?: number;
  now?: () => number;
};

export class AnalyticsQueries {
  private readonly memo: ReturnType<typeof memoAsync<string, unknown>>;

  constructor(
    private readonly clickhouse: ClickHouseClient,
    options: AnalyticsQueriesOptions = {},
  ) {
    this.memo = memoAsync((key) => this.load(key), {
      ttlMs: options.globalCacheTtlMs ?? 60_000,
      maxEntries: options.memoMaxEntries ?? 5_000,
      now: options.now ?? Date.now,
    });
  }

  private load(key: string): Promise<unknown> {
    if (key === "globalStats") return this.loadGlobalStats();
    if (key === "modelStats") return this.loadModelStats();
    const accountId = key.startsWith("userStats:") ? key.slice("userStats:".length) : undefined;
    if (accountId !== undefined) return this.loadUserStats(accountId);
    throw new Error(`Unknown analytics memo key: ${key}`);
  }

  userStats(accountId: string): Promise<UsageStats> {
    return this.memo.get(`userStats:${accountId}`) as Promise<UsageStats>;
  }

  private async loadUserStats(accountId: string): Promise<UsageStats> {
    // Redelivered outbox rows share an event_id; collapse them in the
    // subquery instead of forcing a FINAL merge of every part.
    const result = await this.clickhouse.query({
      query: `
        SELECT
          count() AS total_requests,
          sum(input_tokens) AS total_prompt,
          sum(output_tokens) AS total_completion
        FROM (
          SELECT
            event_id,
            argMax(input_tokens, event_version) AS input_tokens,
            argMax(output_tokens, event_version) AS output_tokens
          FROM hcai.request_events
          WHERE account_id = {account_id:UUID}
          GROUP BY event_id
        )
      `,
      query_params: { account_id: accountId },
      format: "JSONEachRow",
    });
    const [row] = await result.json<StatsRow>();
    return toStats(row);
  }

  globalStats(): Promise<UsageStats> {
    return this.memo.get("globalStats") as Promise<UsageStats>;
  }

  modelStats(): Promise<ModelUsageStats[]> {
    return this.memo.get("modelStats") as Promise<ModelUsageStats[]>;
  }

  private async loadGlobalStats(): Promise<UsageStats> {
    const result = await this.clickhouse.query({
      query: `
        SELECT
          count() AS total_requests,
          sum(input_tokens) AS total_prompt,
          sum(output_tokens) AS total_completion
        FROM hcai.request_events FINAL
      `,
      format: "JSONEachRow",
    });
    const [row] = await result.json<StatsRow>();
    return toStats(row);
  }

  private async loadModelStats(): Promise<ModelUsageStats[]> {
    const result = await this.clickhouse.query({
      query: `
        SELECT
          model,
          count() AS total_requests,
          sum(input_tokens) AS total_prompt,
          sum(output_tokens) AS total_completion
        FROM hcai.request_events FINAL
        GROUP BY model
        HAVING total_prompt + total_completion > 0 OR sum(billed_cost_usd) > 0
        ORDER BY total_prompt + total_completion DESC
      `,
      format: "JSONEachRow",
    });
    const rows = await result.json<StatsRow & { model: string }>();
    return rows.map((row) => ({ model: row.model, ...toStats(row) }));
  }

  async recentRequests(
    accountId: string,
    options: { pageSize?: number; before?: { before: string; beforeId: string } } = {},
  ): Promise<RecentRequestsPage> {
    const pageSize = options.pageSize ?? 50;
    const cursor = options.before;
    const result = await this.clickhouse.query({
      query: `
        SELECT
          request_id,
          formatDateTime(occurred_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS occurred_at_iso,
          model,
          endpoint,
          outcome,
          error_code,
          http_status,
          input_tokens,
          output_tokens,
          toString(billed_cost_usd) AS billed_cost_usd,
          duration_ms,
          api_key_id,
          attributes['ip'] AS ip
        FROM hcai.request_events FINAL
        WHERE
          account_id = {account_id:UUID}
          ${
            cursor
              ? "AND (occurred_at, request_id) < (parseDateTime64BestEffort({before:String}, 3), {before_id:UUID})"
              : ""
          }
        ORDER BY occurred_at DESC, request_id DESC
        LIMIT {limit:UInt32}
      `,
      query_params: {
        account_id: accountId,
        limit: pageSize + 1,
        ...(cursor ? { before: cursor.before, before_id: cursor.beforeId } : {}),
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<{
      request_id: string;
      occurred_at_iso: string;
      model: string;
      endpoint: string;
      outcome: string;
      error_code: string;
      http_status: number;
      input_tokens: string | number;
      output_tokens: string | number;
      billed_cost_usd: string;
      duration_ms: string | number;
      api_key_id: string | null;
      ip: string;
    }>();
    const page = rows.slice(0, pageSize).map((row) => ({
      requestId: row.request_id,
      occurredAt: row.occurred_at_iso,
      model: row.model,
      endpoint: row.endpoint,
      outcome: row.outcome,
      errorCode: row.error_code,
      httpStatus: Number(row.http_status),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      billedCostUsd: row.billed_cost_usd,
      durationMs: Number(row.duration_ms),
      apiKeyId: row.api_key_id,
      ip: row.ip,
    }));
    const last = page.at(-1);
    return {
      requests: page,
      next:
        rows.length > pageSize && last
          ? { before: last.occurredAt, beforeId: last.requestId }
          : null,
    };
  }
}

export type DailySpending = {
  spentUsd: string;
  limitUsd: string;
};

export async function dailySpending(
  sql: postgres.Sql,
  accountId: string,
): Promise<DailySpending> {
  const [row] = await sql<{ spent: string; granted: string }[]>`
    SELECT
      COALESCE(SUM(funding_window.committed_usd + funding_window.reserved_usd), 0)::text AS spent,
      COALESCE(SUM(funding_window.granted_usd), 0)::text AS granted
    FROM billing_funding_windows AS funding_window
    JOIN billing_funding_policies AS policy ON policy.id = funding_window.policy_id
    WHERE
      funding_window.account_id = ${accountId}::uuid
      AND policy.cadence = 'day'
      AND funding_window.superseded_at IS NULL
      AND funding_window.window_start <= now()
      AND funding_window.window_end > now()
  `;
  const [policy] = await sql<{ amount: string }[]>`
    SELECT COALESCE(SUM(amount_usd), 0)::text AS amount
    FROM billing_funding_policies
    WHERE account_id = ${accountId}::uuid AND cadence = 'day' AND enabled
  `;
  return {
    spentUsd: row?.spent ?? "0",
    // Before the first request of the day no window exists yet; fall back to
    // the policy amount so the header shows the real allowance.
    limitUsd: row && Number(row.granted) > 0 ? row.granted : (policy?.amount ?? "0"),
  };
}
