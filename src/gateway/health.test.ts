import { describe, expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

import { createHealthCheck, type HealthReport } from "./health";

type State = {
  postgres: boolean;
  clickhouse: boolean;
  key: Response;
  credits?: Response;
  replicate?: Response;
  mistral?: Response;
  exa?: Response;
};

const deps = (state: State) => {
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
        const url = String(input);
        if (url === "https://upstream.test/api/v1/key") {
          fetches += 1;
          return state.key.clone();
        }
        if (url === "https://upstream.test/api/v1/credits") {
          return state.credits?.clone() ?? new Response("", { status: 404 });
        }
        if (url === "https://replicate.com/api/users/hc/unused-credit") {
          return state.replicate?.clone() ?? new Response("", { status: 404 });
        }
        if (url === "https://api.mistral.ai/v1/models") {
          return state.mistral?.clone() ?? Response.json({ data: [] });
        }
        if (url === "https://api.exa.ai/search") {
          return state.exa?.clone() ?? Response.json({ error: "Invalid request body" }, { status: 400 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }) as typeof fetch,
    },
    mistral: { apiKey: "m" },
    exa: { apiKey: "e" },
  };
};

describe("createHealthCheck", () => {
  test("reports up with key details and caches the verdict", async () => {
    let clock = 0;
    const state = {
      postgres: true,
      clickhouse: true,
      key: Response.json({ data: { limit_remaining: 12.5, usage: 3 } }),
      credits: Response.json({ data: { total_credits: 100, total_usage: 40.5 } }),
      replicate: Response.json({ unused_credit: "7.25" }),
    };
    const d = deps(state);
    const health = createHealthCheck({
      ...d,
      replicate: { username: "hc", sessionId: "s" },
      cacheMs: 30_000,
      now: () => clock,
    });

    const first = await health();
    expect(first.status).toBe(200);
    const body = (await first.json()) as HealthReport;
    expect(body.status).toBe("up");
    expect(body.keyLimitRemaining).toBe(12.5);
    expect(body.dailyKeyUsageRemaining).toBe(12.5);
    expect(body.keyUsage).toBe(3);
    expect(body.balanceRemaining).toBe(59.5);
    expect(body.replicateUnusedCredit).toBe(7.25);
    expect(body.startup).toBeTrue();

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
    expect(body.balanceRemaining).toBeUndefined();
  });

  test("is down when Replicate credit is exhausted", async () => {
    const d = deps({
      postgres: true,
      clickhouse: true,
      key: Response.json({ data: { limit_remaining: 1, usage: 0 } }),
      replicate: Response.json({ unused_credit: "0.10" }),
    });
    const response = await createHealthCheck({
      ...d,
      replicate: { username: "hc", sessionId: "s" },
      cacheMs: 0,
    })();
    expect(response.status).toBe(503);
    const body = (await response.json()) as HealthReport;
    expect(body.replicateUnusedCredit).toBe(0.1);
    expect(body.openRouter).toBeTrue();
  });

  test("is down while background services failed to start", async () => {
    const d = deps({
      postgres: true,
      clickhouse: true,
      key: Response.json({ data: { limit_remaining: 1, usage: 0 } }),
    });
    let failure: Error | null = new Error("graphile migration failed");
    const health = createHealthCheck({ ...d, cacheMs: 0, startupError: () => failure });
    const down = await health();
    expect(down.status).toBe(503);
    expect(((await down.json()) as HealthReport).startup).toBeFalse();

    failure = null;
    const up = await health();
    expect(up.status).toBe(200);
    expect(((await up.json()) as HealthReport).startup).toBeTrue();
  });

  test("treats an accepted Mistral key and Exa's body rejection as up", async () => {
    const d = deps({
      postgres: true,
      clickhouse: true,
      key: Response.json({ data: { limit_remaining: 1, usage: 0 } }),
      mistral: Response.json({ data: [] }),
      exa: Response.json({ error: "Invalid request body" }, { status: 400 }),
    });
    const response = await createHealthCheck({ ...d, cacheMs: 0 })();
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthReport;
    expect(body.mistral).toBeTrue();
    expect(body.exa).toBeTrue();
  });

  test("is down when Mistral or Exa reject their key", async () => {
    const d = deps({
      postgres: true,
      clickhouse: true,
      key: Response.json({ data: { limit_remaining: 1, usage: 0 } }),
      mistral: Response.json({ detail: "Invalid API Key" }, { status: 401 }),
      exa: Response.json({ tag: "INVALID_API_KEY" }, { status: 401 }),
    });
    const response = await createHealthCheck({ ...d, cacheMs: 0 })();
    expect(response.status).toBe(503);
    const body = (await response.json()) as HealthReport;
    expect(body.mistral).toBeFalse();
    expect(body.exa).toBeFalse();
    expect(body.openRouter).toBeTrue();
  });
});
