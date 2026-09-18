import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type postgres from "postgres";

import type { FinalizeInput, Reservation, ReserveInput } from "../../billing/engine";
import { Usd } from "../../billing/money";
import type { Fetch } from "../../providers/openrouter/adapter";
import { HttpError } from "../http-error";
import type { BillingLifecycle } from "../metered-request";
import { jevCost, jevModelLabel, jevRoutes, jevTokens } from "./jev";

type Call =
  | { method: "reserve"; input: ReserveInput }
  | { method: "finalize"; input: FinalizeInput }
  | { method: "release"; requestId: string }
  | { method: "markPendingReconciliation"; requestId: string; reason: string };

const reservationFor = (requestId: string, state: Reservation["state"]): Reservation => ({
  id: "reservation-1",
  requestId,
  accountId: "account-1",
  provider: "typesafe",
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
          is_banned: false,
          is_idv_verified: true,
          skip_idv: false,
        },
      ];
    }
    return [];
  }) as unknown as postgres.Sql;

const fakeFetch = (respond: () => Response) => {
  const upstream: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  const fetchImplementation: Fetch = async (input, init) => {
    upstream.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    });
    return respond();
  };
  return { fetch: fetchImplementation, upstream };
};

type Overrides = Partial<Parameters<typeof jevRoutes>[0]>;

const build = (respond: () => Response, overrides: Overrides = {}) => {
  const { billing, calls, done } = fakeBilling();
  const { fetch, upstream } = fakeFetch(respond);
  const routes = jevRoutes({
    sql: fakeSql(),
    billing,
    enforceIdv: false,
    fetch,
    typesafeApiKey: "ts-key",
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

const post = (path: string, body: unknown) =>
  request(path, { method: "POST", body: JSON.stringify(body) });

const successBody = {
  model: "jev-1.13.0",
  answers: { q1: { type: "score", score: 0.9 } },
  usage: { input_tokens: 1_000_000, output_tokens: 48 },
};

describe("jev helpers", () => {
  test("extracts token usage and ignores malformed counts", () => {
    expect(jevTokens(successBody)).toEqual({ inputTokens: 1_000_000, outputTokens: 48 });
    expect(jevTokens({ usage: { input_tokens: 5 } })).toEqual({ inputTokens: 5, outputTokens: 0 });
    expect(jevTokens({ usage: { input_tokens: -1 } })).toBeNull();
    expect(jevTokens({ usage: { input_tokens: "5" } })).toBeNull();
    expect(jevTokens({})).toBeNull();
    expect(jevTokens("nope")).toBeNull();
  });

  test("prices input tokens only", () => {
    const price = Usd.parse("0.042");
    expect(jevCost(successBody, price)?.toString()).toBe(Usd.parse("0.042").toString());
    expect(jevCost({ usage: { input_tokens: 312, output_tokens: 1_000_000 } }, price)?.toString()).toBe(
      "0.000013104000",
    );
    expect(jevCost({ usage: { input_tokens: 0 } }, price)?.toString()).toBe(Usd.zero.toString());
    expect(jevCost({ answers: {} }, price)).toBeNull();
  });

  test("labels models under the jev/ namespace, preferring the response's versioned id", () => {
    expect(jevModelLabel("jev-1.13.0", "jev-latest")).toBe("jev/jev-1.13.0");
    expect(jevModelLabel(null, "jev-preview")).toBe("jev/jev-preview");
    expect(jevModelLabel(undefined)).toBe("jev/jev-latest");
    expect(jevModelLabel("", "")).toBe("jev/jev-latest");
  });
});

describe("jevRoutes", () => {
  test("requires authentication", async () => {
    const { app } = build(() => Response.json(successBody));
    const response = await app.handle(
      new Request("http://gateway.test/proxy/v1/jev/systemone", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects models outside the Jev family before reserving", async () => {
    const { app, calls, upstream } = build(() => Response.json(successBody));
    const response = await app.handle(post("/proxy/v1/jev/systemone", { model: "gpt-4o", state: "x" }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(upstream).toEqual([]);
  });

  test("rejects invalid JSON bodies", async () => {
    const { app } = build(() => Response.json(successBody));
    const response = await app.handle(request("/proxy/v1/jev/systemone", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });

  test("forwards systemone, defaults the model, and bills reported input tokens", async () => {
    const { app, upstream, calls, done } = build(() => Response.json(successBody));
    const response = await app.handle(
      post("/proxy/v1/jev/systemone", { state: "hello", questions: { q1: { type: "score" } } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(successBody);

    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(upstream[0]?.method).toBe("POST");
    expect(upstream[0]?.headers.get("authorization")).toBe("Bearer ts-key");
    expect(upstream[0]?.body).toEqual({
      state: "hello",
      questions: { q1: { type: "score" } },
      model: "jev-latest",
    });

    await done;
    expect(calls.map((call) => call.method)).toEqual(["reserve", "finalize"]);
    const reserve = calls[0];
    if (reserve?.method !== "reserve") throw new Error("expected reserve");
    expect(reserve.input.accountId).toBe("account-1");
    expect(reserve.input.provider).toBe("typesafe");
    expect(reserve.input.estimatedCostUsd.toString()).toBe(Usd.parse("0.02").toString());

    const finalize = calls[1];
    if (finalize?.method !== "finalize") throw new Error("expected finalize");
    expect(finalize.input.actualCostUsd.toString()).toBe(Usd.parse("0.042").toString());
    expect(finalize.input.usageSource).toBe("provider_reported");
    const analytics = finalize.input.analytics as Record<string, unknown>;
    // Logged under the versioned id the response reported, not the alias requested.
    expect(analytics.model).toBe("jev/jev-1.13.0");
    expect(analytics.endpoint).toBe("jev/systemone");
    expect(analytics.input_tokens).toBe(1_000_000);
    expect(analytics.output_tokens).toBe(48);
    expect(analytics.user_id).toBe("user-1");
    expect(analytics.api_key_id).toBe("key-1");
  });

  test("keeps the requested model and honours a configured price", async () => {
    const { app, upstream, calls, done } = build(
      () => Response.json({ ...successBody, usage: { input_tokens: 2_000_000, output_tokens: 0 } }),
      { inputPricePerMillionTokensUsd: "0.1", reservationUsd: "0.5" },
    );
    const response = await app.handle(post("/proxy/v1/jev/v1/systemone", { state: "x", model: "jev-preview" }));
    expect(response.status).toBe(200);
    expect(upstream[0]?.body).toEqual({ state: "x", model: "jev-preview" });

    await done;
    const reserve = calls[0];
    if (reserve?.method !== "reserve") throw new Error("expected reserve");
    expect(reserve.input.estimatedCostUsd.toString()).toBe(Usd.parse("0.5").toString());
    const finalize = calls[1];
    if (finalize?.method !== "finalize") throw new Error("expected finalize");
    expect(finalize.input.actualCostUsd.toString()).toBe(Usd.parse("0.2").toString());
  });

  test("finalizes at zero when TypeSafe rejects the request", async () => {
    const { app, calls, done } = build(() => Response.json({ error: "bad state" }, { status: 422 }));
    const response = await app.handle(post("/proxy/v1/jev/systemone", { state: "x" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "bad state" });

    await done;
    const finalize = calls[1];
    if (finalize?.method !== "finalize") throw new Error("expected finalize");
    expect(finalize.input.actualCostUsd.toString()).toBe(Usd.zero.toString());
    const analytics = finalize.input.analytics as Record<string, unknown>;
    expect(analytics.model).toBe("jev/jev-latest");
    expect(analytics.outcome).toBe("provider_error");
  });

  test("marks a success without usage pending reconciliation", async () => {
    const { app, calls, done } = build(() => Response.json({ model: "jev-1.13.0", answers: {} }));
    const response = await app.handle(post("/proxy/v1/jev/systemone", { state: "x" }));
    expect(response.status).toBe(200);
    await done;
    expect(calls.map((call) => call.method)).toEqual(["reserve", "markPendingReconciliation"]);
  });

  test("releases the reservation when the upstream call fails", async () => {
    const { app, calls } = build(() => {
      throw new Error("connection reset");
    });
    const response = await app.handle(post("/proxy/v1/jev/systemone", { state: "x" }));
    expect(response.status).toBe(500);
    expect(calls.map((call) => call.method)).toEqual(["reserve", "release"]);
  });

  test("passes models through without billing on both prefixes", async () => {
    const listing = { models: [{ name: "jev-latest", description: "alias", release_date: "2026-01-01" }] };
    const { app, upstream, calls } = build(
      () => Response.json(listing, { headers: { "content-encoding": "gzip", "x-upstream": "1" } }),
    );
    for (const path of ["/proxy/v1/jev/models", "/proxy/v1/jev/v1/models"]) {
      const response = await app.handle(request(path));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(listing);
      expect(response.headers.get("x-upstream")).toBe("1");
      expect(response.headers.get("content-encoding")).toBeNull();
    }
    expect(upstream.map((call) => call.url)).toEqual([
      "https://api.typesafe.ai/v1/models",
      "https://api.typesafe.ai/v1/models",
    ]);
    expect(upstream[0]?.method).toBe("GET");
    expect(upstream[0]?.headers.get("authorization")).toBe("Bearer ts-key");
    expect(calls).toHaveLength(0);
  });
});
