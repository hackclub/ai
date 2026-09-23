import { describe, expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";

import { AnalyticsQueries } from "./queries";

type Query = { query: string; query_params?: Record<string, unknown> };

/** AnalyticsQueries over a ClickHouse fake that answers every query with `rows`. */
const queriesReturning = (rows: unknown[]) => {
  const queries: Query[] = [];
  const client = {
    query: async (args: Query) => {
      queries.push(args);
      return { json: async () => rows };
    },
  } as unknown as ClickHouseClient;
  return { analytics: new AnalyticsQueries(client), queries, last: () => queries.at(-1)! };
};

const statsRow = { total_requests: "2", total_prompt: "10", total_completion: "5" };

describe("AnalyticsQueries stats", () => {
  test("sums prompt and completion tokens", async () => {
    const { analytics } = queriesReturning([statsRow]);
    expect(await analytics.globalStats()).toEqual({
      totalRequests: 2,
      totalTokens: 15,
      totalPromptTokens: 10,
      totalCompletionTokens: 5,
    });
  });

  test("memoizes each stat, and userStats per account, under its own key", async () => {
    const { analytics, queries } = queriesReturning([statsRow]);
    await analytics.globalStats();
    await analytics.modelStats();
    await analytics.userStats("a");
    await analytics.userStats("b");
    await analytics.globalStats();
    await analytics.userStats("a");
    expect(queries).toHaveLength(4);
  });

  test("userStats avoids FINAL and groups by event_id", async () => {
    const { analytics, last } = queriesReturning([statsRow]);
    await analytics.userStats("account-1");
    expect(last().query).not.toContain("FINAL");
    expect(last().query).toContain("GROUP BY event_id");
    expect(last().query_params?.account_id).toBe("account-1");
  });
});

const row = (i: number) => ({
  request_id: `00000000-0000-4000-8000-00000000000${i}`,
  occurred_at_iso: `2026-09-19T00:00:0${i}.000Z`,
  model: "m",
  endpoint: "e",
  outcome: "completed",
  error_code: "",
  http_status: 200,
  input_tokens: "1",
  output_tokens: "1",
  billed_cost_usd: "0.000000000001",
  duration_ms: "5",
  api_key_id: null,
  ip: "",
});

describe("recentRequests", () => {
  test("fetches one extra row to decide whether there is a next page", async () => {
    const { analytics, last } = queriesReturning([row(3), row(2), row(1)]);
    const page = await analytics.recentRequests("account-1", { pageSize: 2 });
    expect(page.requests).toHaveLength(2);
    expect(page.next).toEqual({ before: page.requests[1]!.occurredAt, beforeId: page.requests[1]!.requestId });
    expect(last().query).not.toContain("before_id");
    expect(last().query_params?.limit).toBe(3);
  });

  test("exactly pageSize rows means no next page", async () => {
    const { analytics } = queriesReturning([row(2), row(1)]);
    expect((await analytics.recentRequests("account-1", { pageSize: 2 })).next).toBeNull();
  });

  test("cursor is bound as parameters, not interpolated", async () => {
    const { analytics, last } = queriesReturning([row(1)]);
    const beforeId = "00000000-0000-4000-8000-000000000009";
    await analytics.recentRequests("account-1", {
      pageSize: 2,
      before: { before: "2026-09-19T00:00:00.000Z", beforeId },
    });
    expect(last().query).toContain("{before:String}");
    expect(last().query).toContain("{before_id:UUID}");
    expect(last().query_params?.before_id).toBe(beforeId);
    expect(last().query).not.toContain(beforeId);
  });
});
