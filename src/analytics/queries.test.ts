import { describe, expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";

import { AnalyticsQueries } from "./queries";

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

  test("refreshes after the TTL and shares one in-flight query", async () => {
    const clock = { now: 0 };
    const { client, calls } = fakeClickHouse([() => [statsRow], () => [{ ...statsRow, total_requests: "3" }]]);
    const queries = new AnalyticsQueries(client, { globalCacheTtlMs: 1_000, now: () => clock.now });
    await Promise.all([queries.globalStats(), queries.globalStats()]);
    expect(calls()).toBe(1);
    clock.now = 1_000;
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
