import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type postgres from "postgres";

import type { FinalizeInput, Reservation, ReserveInput } from "../../billing/engine";
import { Usd } from "../../billing/money";
import type { Fetch } from "../../providers/openrouter/adapter";
import { HttpError } from "../http-error";
import type { BillingLifecycle } from "../metered-request";
import { exaCost, exaRequestId, exaRoutes } from "./exa";

describe("exaCost", () => {
  test("reads costDollars.total", () => {
    expect(exaCost({ costDollars: { total: 0.003 } })?.toString()).toBe("0.003000000000");
  });

  test("rejects a negative cost", () => {
    expect(exaCost({ costDollars: { total: -1 } })).toBeNull();
  });

  test("rejects a missing cost", () => {
    expect(exaCost({})).toBeNull();
  });

  test("rejects a null body", () => {
    expect(exaCost(null)).toBeNull();
  });

  test("rejects a non-number cost", () => {
    expect(exaCost({ costDollars: { total: "1" } })).toBeNull();
  });
});

describe("exaRequestId", () => {
  test("reads a string requestId", () => {
    expect(exaRequestId({ requestId: "r1" })).toBe("r1");
  });

  test("returns null when missing", () => {
    expect(exaRequestId({})).toBeNull();
  });
});

type Call =
  | { method: "reserve"; input: ReserveInput }
  | { method: "finalize"; input: FinalizeInput }
  | { method: "release"; requestId: string }
  | { method: "markPendingReconciliation"; requestId: string; reason: string };

const reservationFor = (requestId: string, state: Reservation["state"]): Reservation => ({
  id: "reservation-1",
  requestId,
  accountId: "account-1",
  provider: "exa",
  providerRequestId: null,
  state,
  estimatedCostUsd: "0.020000000000",
  actualCostUsd: null,
  unfundedCostUsd: "0.000000000000",
  expiresAt: new Date(0),
});

const fakeBilling = () => {
  const calls: Call[] = [];
  let settled: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const billing: BillingLifecycle = {
    async reserve(input) {
      calls.push({ method: "reserve", input });
      return reservationFor(input.requestId, "reserved");
    },
    async finalize(input) {
      calls.push({ method: "finalize", input });
      settled();
      return reservationFor(input.requestId, "finalized");
    },
    async release(requestId) {
      calls.push({ method: "release", requestId });
      settled();
      return reservationFor(requestId, "released");
    },
    async markPendingReconciliation(requestId, reason) {
      calls.push({ method: "markPendingReconciliation", requestId, reason });
      settled();
      return reservationFor(requestId, "pending_reconciliation");
    },
  };
  return { billing, calls, done };
};

/** Answers the queries the route path issues: key lookup and usage stamp. */
const fakeSql = () =>
  (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM api_keys")) {
      return [
        {
          api_key_id: "key-1",
          user_id: "user-1",
          billing_account_id: "account-1",
          billing_account_status: "active",
          is_banned: false,
          is_idv_verified: true,
          skip_idv: false,
        },
      ];
    }
    return [];
  }) as unknown as postgres.Sql;

const fakeFetch = (respond: () => Response) => {
  const upstream: Array<{ url: string; method: string; headers: Headers }> = [];
  const fetchImplementation: Fetch = async (input, init) => {
    upstream.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    return respond();
  };
  return { fetch: fetchImplementation, upstream };
};

type Overrides = Partial<Parameters<typeof exaRoutes>[0]>;

const build = (respond: () => Response, overrides: Overrides = {}) => {
  const { billing, calls, done } = fakeBilling();
  const { fetch, upstream } = fakeFetch(respond);
  const routes = exaRoutes({
    sql: fakeSql(),
    billing,
    enforceIdv: false,
    fetch,
    exaApiKey: "exa-key",
    ...overrides,
  });
  // Mirrors the HttpError handling createApp installs in front of every route group.
  const app = new Elysia()
    .error(({ error }) =>
      error instanceof HttpError
        ? error.toResponse()
        : Response.json({ error: "Internal server error" }, { status: 500 }),
    )
    .use(routes);
  return { app, calls, upstream, done };
};

const request = (path: string, init: RequestInit = {}) =>
  new Request(`http://gateway.test${path}`, {
    headers: { authorization: "Bearer sk-hc-v1-test", "content-type": "application/json" },
    ...init,
  });

const post = (path: string, body: unknown, init: RequestInit = {}) =>
  request(path, { method: "POST", body: JSON.stringify(body), ...init });

const successBody = { requestId: "r1", costDollars: { total: 0.002 }, results: [] };

describe("exaRoutes", () => {
  test("503s when Exa is not configured", async () => {
    const { app } = build(() => Response.json(successBody), { exaApiKey: null });
    const response = await app.handle(post("/proxy/v1/exa/search", { query: "hi" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Exa is not configured" });
  });

  test("rejects streaming requests", async () => {
    const { app, calls, upstream } = build(() => Response.json(successBody));
    const response = await app.handle(post("/proxy/v1/exa/search", { query: "hi", stream: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Streaming is not supported for Exa endpoints" });
    expect(upstream).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("forwards the configured x-api-key and returns an x-request-id header", async () => {
    const { app, upstream } = build(() => Response.json(successBody));
    const response = await app.handle(post("/proxy/v1/exa/search", { query: "hi" }));
    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.headers.get("x-api-key")).toBe("exa-key");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("finalizes billing at Exa's reported cost", async () => {
    const { app, calls, done } = build(() => Response.json(successBody));
    const response = await app.handle(post("/proxy/v1/exa/search", { query: "hi" }));
    await response.text();
    await done;
    const finalize = calls.find((call) => call.method === "finalize");
    if (finalize?.method !== "finalize") throw new Error("expected finalize");
    expect(finalize.input.actualCostUsd.toString()).toBe(Usd.parse("0.002").toString());
  });

  test("authenticates with x-api-key and no authorization header", async () => {
    const { app } = build(() => Response.json(successBody));
    const response = await app.handle(
      new Request("http://gateway.test/proxy/v1/exa/search", {
        method: "POST",
        headers: { "x-api-key": "sk-hc-v1-x", "content-type": "application/json" },
        body: JSON.stringify({ query: "hi" }),
      }),
    );
    expect(response.status).toBe(200);
  });
});
