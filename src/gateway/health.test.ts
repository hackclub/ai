import { expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

import { createHealthCheck, type HealthOptions, type HealthReport } from "./health";

type State = {
  postgres: boolean;
  clickhouse: boolean;
  key: Response;
  credits?: Response;
  replicate?: Response;
  mistral?: Response;
  exa?: Response;
};

const notFound = () => new Response("", { status: 404 });

/** Healthy by default: Mistral lists models and Exa rejects the empty body with 400. */
const deps = (overrides: Partial<State> = {}) => {
  const state: State = {
    postgres: true,
    clickhouse: true,
    key: Response.json({ data: { limit_remaining: 1, usage: 0 } }),
    ...overrides,
  };
  let keyFetches = 0;
  const responses: Record<string, () => Response> = {
    "https://upstream.test/api/v1/key": () => {
      keyFetches += 1;
      return state.key.clone();
    },
    "https://upstream.test/api/v1/credits": () => state.credits?.clone() ?? notFound(),
    "https://replicate.com/api/users/hc/unused-credit": () => state.replicate?.clone() ?? notFound(),
    "https://api.mistral.ai/v1/models": () => state.mistral?.clone() ?? Response.json({ data: [] }),
    "https://api.exa.ai/search": () =>
      state.exa?.clone() ?? Response.json({ error: "Invalid request body" }, { status: 400 }),
  };
  const options: HealthOptions = {
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
        const respond = responses[String(input)];
        if (!respond) throw new Error(`Unexpected fetch ${String(input)}`);
        return respond();
      }) as typeof fetch,
    },
    mistral: { apiKey: "m" },
    exa: { apiKey: "e" },
    cacheMs: 0,
  };
  return { state, options, keyFetches: () => keyFetches };
};

const report = async (response: Response) => (await response.json()) as HealthReport;

test("reports up with key details and caches the verdict", async () => {
  let clock = 0;
  const { state, options, keyFetches } = deps({
    key: Response.json({ data: { limit_remaining: 12.5, usage: 3 } }),
    credits: Response.json({ data: { total_credits: 100, total_usage: 40.5 } }),
    replicate: Response.json({ unused_credit: "7.25" }),
  });
  const health = createHealthCheck({
    ...options,
    replicate: { username: "hc", sessionId: "s" },
    cacheMs: 30_000,
    now: () => clock,
  });

  const first = await health();
  expect(first.status).toBe(200);
  expect(await report(first)).toMatchObject({
    status: "up",
    keyLimitRemaining: 12.5,
    dailyKeyUsageRemaining: 12.5,
    keyUsage: 3,
    balanceRemaining: 59.5,
    replicateUnusedCredit: 7.25,
  });

  state.postgres = false;
  clock = 10_000;
  expect((await health()).status).toBe(200);
  expect(keyFetches()).toBe(1);

  clock = 31_000;
  const stale = await health();
  expect(stale.status).toBe(503);
  expect((await report(stale)).postgres).toBeFalse();
  expect(keyFetches()).toBe(2);
});

test("is down when OpenRouter rejects the key", async () => {
  const response = await createHealthCheck(deps({ key: new Response("", { status: 401 }) }).options)();
  expect(response.status).toBe(503);
  const body = await report(response);
  expect(body.openRouter).toBeFalse();
  expect(body.keyLimitRemaining).toBeUndefined();
  expect(body.balanceRemaining).toBeUndefined();
});

test("is down when Replicate credit is exhausted", async () => {
  const { options } = deps({ replicate: Response.json({ unused_credit: "0.10" }) });
  const response = await createHealthCheck({ ...options, replicate: { username: "hc", sessionId: "s" } })();
  expect(response.status).toBe(503);
  expect(await report(response)).toMatchObject({ replicateUnusedCredit: 0.1, openRouter: true });
});

test("is down when Mistral or Exa reject their key", async () => {
  const { options } = deps({
    mistral: Response.json({ detail: "Invalid API Key" }, { status: 401 }),
    exa: Response.json({ tag: "INVALID_API_KEY" }, { status: 401 }),
  });
  const response = await createHealthCheck(options)();
  expect(response.status).toBe(503);
  expect(await report(response)).toMatchObject({ mistral: false, exa: false, openRouter: true });
});
