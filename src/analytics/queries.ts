import type { ClickHouseClient } from "@clickhouse/client";

import { memoAsync } from "../cache/memo-async";

export type UsageStats = {
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
};

export type GlobalRange = "day" | "week" | "month" | "all";

export type GlobalOverview = {
  totals: { requests: number; tokens: number; users: number };
  /** Top models by tokens, routing variants folded into their base model. */
  models: { model: string; requests: number; tokens: number }[];
  /** Tokens per model author (the part of the id before the slash). */
  authors: { author: string; tokens: number }[];
  /** Tokens per UTC day over the last 30 days for the top models; the rest are `model: ""`. */
  daily: { day: string; model: string; tokens: number }[];
};

const RANGE_FILTER: Record<GlobalRange, string> = {
  day: "occurred_at >= now() - INTERVAL 1 DAY",
  week: "occurred_at >= now() - INTERVAL 7 DAY",
  month: "occurred_at >= now() - INTERVAL 30 DAY",
  all: "1",
};

/** `openai/gpt-4o:nitro` → `openai/gpt-4o`. */
const BASE_MODEL = "splitByChar(':', model)[1]";
/** `openai/gpt-4o` → `openai`; ids without an author fall back to the provider. */
const AUTHOR = "if(position(model, '/') > 0, trimLeft(splitByChar('/', model)[1], '~'), provider)";

export type RecentRequest = {
  requestId: string;
  occurredAt: string;
  provider: string;
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

export type RecentRequestFilters = {
  /** Matched against the model, request id and error code. */
  search?: string;
  status?: "ok" | "error";
  apiKeyId?: string;
  model?: string;
};

export type RequestDetail = RecentRequest & {
  streamed: boolean;
  timeToFirstByteMs: number | null;
  providerCostUsd: string | null;
  userAgent: string;
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
    const range = key.startsWith("globalOverview:") ? key.slice("globalOverview:".length) : undefined;
    if (range !== undefined) return this.loadGlobalOverview(range as GlobalRange);
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
          FROM request_events
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

  /** Usage across every account over `range`, served from memory for a minute. */
  globalOverview(range: GlobalRange): Promise<GlobalOverview> {
    return this.memo.get(`globalOverview:${range}`) as Promise<GlobalOverview>;
  }

  private async loadGlobalOverview(range: GlobalRange): Promise<GlobalOverview> {
    const where = RANGE_FILTER[range];
    const rows = async <T>(query: string) =>
      (await this.clickhouse.query({ query, format: "JSONEachRow" })).json<T>();
    const [[totals], models, authors, daily] = await Promise.all([
      rows<{ requests: string; tokens: string; users: string }>(`
        SELECT count() AS requests, sum(input_tokens + output_tokens) AS tokens, uniqExact(account_id) AS users
        FROM request_events FINAL
        WHERE ${where}
      `),
      rows<{ base: string; requests: string; tokens: string }>(`
        SELECT ${BASE_MODEL} AS base, count() AS requests, sum(input_tokens + output_tokens) AS tokens
        FROM request_events FINAL
        WHERE ${where} AND model != ''
        GROUP BY base
        HAVING tokens > 0
        ORDER BY tokens DESC
        LIMIT 20
      `),
      rows<{ author: string; tokens: string }>(`
        SELECT ${AUTHOR} AS author, sum(input_tokens + output_tokens) AS tokens
        FROM request_events FINAL
        WHERE ${where} AND model != ''
        GROUP BY author
        HAVING tokens > 0
        ORDER BY tokens DESC
        LIMIT 10
      `),
      rows<{ day: string; series: string; tokens: string }>(`
        WITH top AS (
          SELECT ${BASE_MODEL} AS base
          FROM request_events FINAL
          WHERE occurred_at >= today() - 29
          GROUP BY base
          HAVING sum(input_tokens + output_tokens) > 0
          ORDER BY sum(input_tokens + output_tokens) DESC
          LIMIT 8
        )
        SELECT
          toString(toDate(occurred_at, 'UTC')) AS day,
          if(${BASE_MODEL} IN (SELECT base FROM top), ${BASE_MODEL}, '') AS series,
          sum(input_tokens + output_tokens) AS tokens
        FROM request_events FINAL
        WHERE occurred_at >= today() - 29
        GROUP BY day, series
        HAVING tokens > 0
        ORDER BY day, tokens DESC
      `),
    ]);
    return {
      totals: {
        requests: Number(totals?.requests ?? 0),
        tokens: Number(totals?.tokens ?? 0),
        users: Number(totals?.users ?? 0),
      },
      models: models.map((row) => ({ model: row.base, requests: Number(row.requests), tokens: Number(row.tokens) })),
      authors: authors.map((row) => ({ author: row.author, tokens: Number(row.tokens) })),
      daily: daily.map((row) => ({ day: row.day, model: row.series, tokens: Number(row.tokens) })),
    };
  }

  async recentRequests(
    accountId: string,
    options: {
      pageSize?: number;
      before?: { before: string; beforeId: string };
      filters?: RecentRequestFilters;
    } = {},
  ): Promise<RecentRequestsPage> {
    const pageSize = options.pageSize ?? 50;
    const cursor = options.before;
    const filters = options.filters ?? {};
    const conditions = [
      cursor
        ? "(occurred_at, request_id) < (parseDateTime64BestEffort({before:String}, 3), {before_id:UUID})"
        : "",
      filters.status === "ok" ? "outcome = 'completed'" : "",
      filters.status === "error" ? "outcome != 'completed'" : "",
      filters.apiKeyId ? "api_key_id = {api_key_id:UUID}" : "",
      filters.model ? "model = {model:String}" : "",
      filters.search
        ? `(
            positionCaseInsensitiveUTF8(model, {search:String}) > 0
            OR startsWith(toString(request_id), lower({search:String}))
            OR positionCaseInsensitiveUTF8(error_code, {search:String}) > 0
          )`
        : "",
    ].filter(Boolean);
    const result = await this.clickhouse.query({
      query: `
        SELECT ${REQUEST_COLUMNS}
        FROM request_events FINAL
        WHERE account_id = {account_id:UUID} ${conditions.map((condition) => `AND ${condition}`).join(" ")}
        ORDER BY occurred_at DESC, request_id DESC
        LIMIT {limit:UInt32}
      `,
      query_params: {
        account_id: accountId,
        limit: pageSize + 1,
        ...(cursor ? { before: cursor.before, before_id: cursor.beforeId } : {}),
        ...(filters.apiKeyId ? { api_key_id: filters.apiKeyId } : {}),
        ...(filters.model ? { model: filters.model } : {}),
        ...(filters.search ? { search: filters.search } : {}),
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<RequestRow>();
    const page = rows.slice(0, pageSize).map(toRecentRequest);
    const last = page.at(-1);
    return {
      requests: page,
      next:
        rows.length > pageSize && last
          ? { before: last.occurredAt, beforeId: last.requestId }
          : null,
    };
  }

  /** One of the account's requests, or null when it is not theirs. */
  async requestDetail(accountId: string, requestId: string): Promise<RequestDetail | null> {
    const result = await this.clickhouse.query({
      query: `
        SELECT
          ${REQUEST_COLUMNS},
          streamed,
          time_to_first_byte_ms,
          if(isNull(provider_cost_usd), NULL, toString(provider_cost_usd)) AS provider_cost_usd,
          request_headers['user-agent'] AS user_agent
        FROM request_events FINAL
        WHERE account_id = {account_id:UUID} AND request_id = {request_id:UUID}
        LIMIT 1
      `,
      query_params: { account_id: accountId, request_id: requestId },
      format: "JSONEachRow",
    });
    const [row] = await result.json<
      RequestRow & {
        streamed: boolean;
        time_to_first_byte_ms: string | number | null;
        provider_cost_usd: string | null;
        user_agent: string;
      }
    >();
    if (!row) return null;
    return {
      ...toRecentRequest(row),
      streamed: Boolean(row.streamed),
      timeToFirstByteMs: row.time_to_first_byte_ms === null ? null : Number(row.time_to_first_byte_ms),
      providerCostUsd: row.provider_cost_usd,
      userAgent: row.user_agent,
    };
  }

  /** Every model the account has called, most used first, for the activity filter. */
  async accountModels(accountId: string): Promise<string[]> {
    const result = await this.clickhouse.query({
      query: `
        SELECT model
        FROM request_events
        WHERE account_id = {account_id:UUID} AND model != ''
        GROUP BY model
        ORDER BY count() DESC
        LIMIT 200
      `,
      query_params: { account_id: accountId },
      format: "JSONEachRow",
    });
    return (await result.json<{ model: string }>()).map((row) => row.model);
  }
}

const REQUEST_COLUMNS = `
  request_id,
  formatDateTime(occurred_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS occurred_at_iso,
  provider,
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
`;

type RequestRow = {
  request_id: string;
  occurred_at_iso: string;
  provider: string;
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
};

const toRecentRequest = (row: RequestRow): RecentRequest => ({
  requestId: row.request_id,
  occurredAt: row.occurred_at_iso,
  provider: row.provider,
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
});
