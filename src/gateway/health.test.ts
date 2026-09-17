import { describe, expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

import { createHealthCheck, type HealthReport } from "./health";

const deps = (state: { postgres: boolean; clickhouse: boolean; key: Response }) => {
  let fetches = 0;
  return {
    fetches: () => fetches,
    sql: (async () => {
      if (!state.postgres) throw new Error("pg down");
      return [{ "?column?": 1 }];
    }) as unknown as postgres.Sql,
    clickhouse: {
      query: async () => {
        if (!state.clickhouse) throw new Error("ch down");
        return {};
      },
    } as unknown as ClickHouseClient,
    openRouter: {
      apiKey: "k",
      baseUrl: "https://upstream.test/api",
      fetch: (async (input) => {
        fetches += 1;
        expect(String(input)).toBe("https://upstream.test/api/v1/key");
        return state.key.clone();
      }) as typeof fetch,
    },
  };
};

describe("createHealthCheck", () => {
  test("reports up with key details and caches the verdict", async () => {
    let clock = 0;
    const state = {
      postgres: true,
      clickhouse: true,
      key: Response.json({ data: { limit_remaining: 12.5, usage: 3 } }),
    };
    const d = deps(state);
    const health = createHealthCheck({ ...d, cacheMs: 30_000, now: () => clock });

    const first = await health();
    expect(first.status).toBe(200);
    const body = (await first.json()) as HealthReport;
    expect(body.status).toBe("up");
    expect(body.keyLimitRemaining).toBe(12.5);
    expect(body.keyUsage).toBe(3);

    state.postgres = false;
    clock = 10_000;
    expect((await health()).status).toBe(200);
    expect(d.fetches()).toBe(1);

    clock = 31_000;
    const stale = await health();
    expect(stale.status).toBe(503);
    expect(((await stale.json()) as HealthReport).postgres).toBeFalse();
    expect(d.fetches()).toBe(2);
  });

  test("is down when OpenRouter rejects the key", async () => {
    const d = deps({
      postgres: true,
      clickhouse: true,
      key: new Response("", { status: 401 }),
    });
    const response = await createHealthCheck({ ...d, cacheMs: 0 })();
    expect(response.status).toBe(503);
    const body = (await response.json()) as HealthReport;
    expect(body.openRouter).toBeFalse();
    expect(body.keyLimitRemaining).toBeUndefined();
  });
});
