import { describe, expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

import { AnalyticsQueries, dailySpending } from "./queries";

const fakeClickHouse = (responses: Array<() => unknown[]>) => {
  let calls = 0;
  let lastQuery: { query: string; query_params?: Record<string, unknown> } | undefined;
  const client = {
    query: async (args: { query: string; query_params?: Record<string, unknown> }) => {
      calls += 1;
      lastQuery = args;
      const next = responses.shift();
      if (!next) throw new Error("No response scripted");
      return { json: async () => next() };
    },
  } as unknown as ClickHouseClient;
  return { client, calls: () => calls, last: () => lastQuery! };
};

const statsRow = { total_requests: "2", total_prompt: "10", total_completion: "5" };

describe("AnalyticsQueries global cache", () => {
  test("serves globalStats from memory within the TTL", async () => {
    const clock = { now: 0 };
    const { client, calls } = fakeClickHouse([() => [statsRow]]);
    const queries = new AnalyticsQueries(client, { globalCacheTtlMs: 60_000, now: () => clock.now });
    expect(await queries.globalStats()).toEqual({
      totalRequests: 2, totalTokens: 15, totalPromptTokens: 10, totalCompletionTokens: 5,
    });
    clock.now = 59_999;
    await queries.globalStats();
    expect(calls()).toBe(1);
  });

  test("serves a stale value past the TTL while refreshing in the background", async () => {
    const clock = { now: 0 };
    const { client, calls } = fakeClickHouse([() => [statsRow], () => [{ ...statsRow, total_requests: "3" }]]);
    const queries = new AnalyticsQueries(client, { globalCacheTtlMs: 1_000, now: () => clock.now });
    await Promise.all([queries.globalStats(), queries.globalStats()]);
    expect(calls()).toBe(1);
    clock.now = 1_000;
    // The first call past the TTL still returns the stale value immediately...
    expect((await queries.globalStats()).totalRequests).toBe(2);
    expect(calls()).toBe(2);
    // ...and the background refresh has updated the cache for the next call.
    await Promise.resolve();
    await Promise.resolve();
    expect((await queries.globalStats()).totalRequests).toBe(3);
    expect(calls()).toBe(2);
  });

  test("keeps serving the last value when a refresh fails", async () => {
    const clock = { now: 0 };
    const { client } = fakeClickHouse([
      () => [{ model: "m", ...statsRow }],
      () => { throw new Error("clickhouse down"); },
    ]);
    const queries = new AnalyticsQueries(client, { globalCacheTtlMs: 1_000, now: () => clock.now });
    const first = await queries.modelStats();
    clock.now = 1_000;
    expect(await queries.modelStats()).toBe(first);
  });

  test("caches globalStats and modelStats independently", async () => {
    const { client, calls } = fakeClickHouse([() => [statsRow], () => [{ model: "m", ...statsRow }]]);
    const queries = new AnalyticsQueries(client);
    await queries.globalStats();
    await queries.modelStats();
    await queries.globalStats();
    expect(calls()).toBe(2);
  });

  test("serves userStats from memory per account", async () => {
    const { client, calls } = fakeClickHouse([
      () => [statsRow],
      () => [statsRow],
    ]);
    const queries = new AnalyticsQueries(client);
    await queries.userStats("a");
    await queries.userStats("a");
    expect(calls()).toBe(1);
    await queries.userStats("b");
    expect(calls()).toBe(2);
  });

  test("userStats avoids FINAL and groups by event_id", async () => {
    const { client, last } = fakeClickHouse([() => [statsRow]]);
    const queries = new AnalyticsQueries(client);
    await queries.userStats("account-1");
    expect(last().query).not.toContain("FINAL");
    expect(last().query).toContain("GROUP BY event_id");
    expect(last().query_params?.account_id).toBe("account-1");
  });

  test("evicts the oldest memo entry beyond the cap", async () => {
    const { client, calls } = fakeClickHouse([
      () => [statsRow],
      () => [statsRow],
      () => [statsRow],
      () => [statsRow],
    ]);
    const queries = new AnalyticsQueries(client, { memoMaxEntries: 2 });
    await queries.userStats("a");
    await queries.userStats("b");
    await queries.userStats("c");
    await queries.userStats("a");
    expect(calls()).toBe(4);
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
  test("first page without a cursor", async () => {
    const { client, last } = fakeClickHouse([() => [row(3), row(2), row(1)]]);
    const queries = new AnalyticsQueries(client);
    const page = await queries.recentRequests("account-1", { pageSize: 2 });
    expect(page.requests.length).toBe(2);
    expect(page.next).toEqual({
      before: page.requests[1]!.occurredAt,
      beforeId: page.requests[1]!.requestId,
    });
    expect(last().query).not.toContain("before_id");
    expect(last().query_params?.limit).toBe(3);
  });

  test("exactly pageSize rows means no next page", async () => {
    const { client } = fakeClickHouse([() => [row(2), row(1)]]);
    const queries = new AnalyticsQueries(client);
    const page = await queries.recentRequests("account-1", { pageSize: 2 });
    expect(page.next).toBeNull();
  });

  test("cursor is bound as parameters, not interpolated", async () => {
    const { client, last } = fakeClickHouse([() => [row(1)]]);
    const queries = new AnalyticsQueries(client);
    const beforeId = "00000000-0000-4000-8000-000000000009";
    await queries.recentRequests("account-1", {
      pageSize: 2,
      before: { before: "2026-09-19T00:00:00.000Z", beforeId },
    });
    expect(last().query).toContain("{before:String}");
    expect(last().query).toContain("{before_id:UUID}");
    expect(last().query_params?.before_id).toBe(beforeId);
    expect(last().query).not.toContain(beforeId);
  });

  test("numeric fields are coerced", async () => {
    const { client } = fakeClickHouse([() => [row(1)]]);
    const queries = new AnalyticsQueries(client);
    const page = await queries.recentRequests("account-1", { pageSize: 2 });
    const request = page.requests[0]!;
    expect(typeof request.httpStatus).toBe("number");
    expect(typeof request.inputTokens).toBe("number");
    expect(typeof request.durationMs).toBe("number");
  });

  test("is not memoized", async () => {
    const { client, calls } = fakeClickHouse([() => [row(1)], () => [row(1)]]);
    const queries = new AnalyticsQueries(client);
    await queries.recentRequests("account-1", { pageSize: 2 });
    await queries.recentRequests("account-1", { pageSize: 2 });
    expect(calls()).toBe(2);
  });
});

const fakeSql = (results: Array<unknown[]>) => {
  let index = 0;
  const fn = (async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const next = results[index];
    index += 1;
    return next ?? [];
  }) as unknown as postgres.Sql;
  return fn;
};

describe("dailySpending", () => {
  test("uses the funding window's granted amount when it is set", async () => {
    const sql = fakeSql([[{ spent: "1.5", granted: "3" }], [{ amount: "3" }]]);
    expect(await dailySpending(sql, "account-1")).toEqual({ spentUsd: "1.5", limitUsd: "3" });
  });

  test("falls back to the policy amount when no window exists yet", async () => {
    const sql = fakeSql([[], [{ amount: "3" }]]);
    expect(await dailySpending(sql, "account-1")).toEqual({ spentUsd: "0", limitUsd: "3" });
  });

  test("falls back to the policy amount when the window granted zero", async () => {
    const sql = fakeSql([[{ spent: "0", granted: "0" }], [{ amount: "5" }]]);
    expect(await dailySpending(sql, "account-1")).toEqual({ spentUsd: "0", limitUsd: "5" });
  });

  test("returns zeroes when there is no window and no policy", async () => {
    const sql = fakeSql([[], []]);
    expect(await dailySpending(sql, "account-1")).toEqual({ spentUsd: "0", limitUsd: "0" });
  });
});
