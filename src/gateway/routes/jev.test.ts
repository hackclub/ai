import { expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { jevCost, jevModelLabel, jevRoutes, jevTokens } from "./jev";
import { fakeBilling, fakeFetch, fakeSql, post } from "./test-harness";

const successBody = {
  model: "jev-1.13.0",
  answers: { q1: { type: "score", score: 0.9 } },
  usage: { input_tokens: 1_000_000, output_tokens: 48 },
};

test("jevTokens extracts token usage and ignores malformed counts", () => {
  expect(jevTokens(successBody)).toEqual({ inputTokens: 1_000_000, outputTokens: 48 });
  expect(jevTokens({ usage: { input_tokens: 5 } })).toEqual({ inputTokens: 5, outputTokens: 0 });
  expect(jevTokens({ usage: { input_tokens: -1 } })).toBeNull();
  expect(jevTokens({ usage: { input_tokens: "5" } })).toBeNull();
  expect(jevTokens({})).toBeNull();
  expect(jevTokens("nope")).toBeNull();
});

test("jevCost prices input tokens only", () => {
  const price = Usd.parse("0.042");
  expect(jevCost(successBody, price)?.toString()).toBe("0.042000000000");
  expect(jevCost({ usage: { input_tokens: 312, output_tokens: 1_000_000 } }, price)?.toString()).toBe(
    "0.000013104000",
  );
  expect(jevCost({ answers: {} }, price)).toBeNull();
});

test("jevModelLabel prefers the response's versioned id, then the fallback, then jev-latest", () => {
  expect(jevModelLabel("jev-1.13.0", "jev-latest")).toBe("jev/jev-1.13.0");
  expect(jevModelLabel(null, "jev-preview")).toBe("jev/jev-preview");
  expect(jevModelLabel("", "")).toBe("jev/jev-latest");
});

type Overrides = Partial<Parameters<typeof jevRoutes>[0]>;

const build = (respond: () => Response, overrides: Overrides = {}) => {
  const fake = fakeBilling();
  const { fetch, upstream } = fakeFetch(respond);
  const app = jevRoutes({
    sql: fakeSql(),
    billing: fake.billing,
    enforceIdv: false,
    fetch,
    typesafeApiKey: "ts-key",
    ...overrides,
  });
  return { app, upstream, ...fake };
};

test("rejects models outside the Jev family before reserving", async () => {
  const { app, calls, upstream } = build(() => Response.json(successBody));
  const response = await app.handle(post("/proxy/v1/jev/systemone", { model: "gpt-4o", state: "x" }));
  expect(response.status).toBe(400);
  expect(calls).toEqual([]);
  expect(upstream).toEqual([]);
});

test("forwards systemone with the default model and bills reported input tokens", async () => {
  const { app, upstream, methods, finalizes, settled } = build(() => Response.json(successBody));
  const response = await app.handle(post("/proxy/v1/jev/systemone", { state: "hello" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(successBody);

  expect(upstream[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(upstream[0]?.headers.get("authorization")).toBe("Bearer ts-key");
  expect(JSON.parse(upstream[0]?.body ?? "")).toEqual({ state: "hello", model: "jev-latest" });

  await settled();
  expect(methods()).toEqual(["reserve", "finalize"]);
  const finalize = finalizes()[0];
  expect(finalize?.actualCostUsd.toString()).toBe("0.042000000000");
  // Logged under the versioned id the response reported, not the alias requested.
  expect(finalize?.analytics?.model).toBe("jev/jev-1.13.0");
  expect(finalize?.analytics?.input_tokens).toBe(1_000_000);
});

test("keeps the requested model and honours configured prices on the /v1 prefix", async () => {
  const { app, upstream, reserves, finalizes, settled } = build(
    () => Response.json({ ...successBody, usage: { input_tokens: 2_000_000, output_tokens: 0 } }),
    { inputPricePerMillionTokensUsd: "0.1", reservationUsd: "0.5" },
  );
  const response = await app.handle(post("/proxy/v1/jev/v1/systemone", { state: "x", model: "jev-preview" }));
  expect(response.status).toBe(200);
  expect(JSON.parse(upstream[0]?.body ?? "")).toEqual({ state: "x", model: "jev-preview" });

  await settled();
  expect(reserves()[0]?.estimatedCostUsd.toString()).toBe("0.500000000000");
  expect(finalizes()[0]?.actualCostUsd.toString()).toBe("0.200000000000");
});

test("an upstream rejection finalizes at zero under the requested model label", async () => {
  const { app, finalizes, settled } = build(() => Response.json({ error: "bad state" }, { status: 422 }));
  const response = await app.handle(post("/proxy/v1/jev/systemone", { state: "x" }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "bad state" });

  await settled();
  expect(finalizes()[0]?.actualCostUsd.toAtoms()).toBe(0n);
  expect(finalizes()[0]?.analytics?.model).toBe("jev/jev-latest");
});

test("marks a success without usage pending reconciliation", async () => {
  const { app, methods, settled } = build(() => Response.json({ model: "jev-1.13.0", answers: {} }));
  const response = await app.handle(post("/proxy/v1/jev/systemone", { state: "x" }));
  expect(response.status).toBe(200);
  await settled();
  expect(methods()).toEqual(["reserve", "markPendingReconciliation"]);
});

test("passes models through unbilled on both prefixes, filtering headers", async () => {
  const listing = { models: [{ name: "jev-latest", description: "alias", release_date: "2026-01-01" }] };
  const { app, upstream, calls } = build(() =>
    Response.json(listing, { headers: { "content-encoding": "gzip", "x-upstream": "1" } }),
  );
  for (const path of ["/proxy/v1/jev/models", "/proxy/v1/jev/v1/models"]) {
    const response = await app.handle(
      new Request(`http://gateway.test${path}`, { headers: { authorization: "Bearer sk-hc-v1-test" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(listing);
    expect(response.headers.get("x-upstream")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
  }
  expect(upstream.map((call) => call.url)).toEqual([
    "https://api.typesafe.ai/v1/models",
    "https://api.typesafe.ai/v1/models",
  ]);
  expect(upstream[0]?.headers.get("authorization")).toBe("Bearer ts-key");
  expect(calls).toEqual([]);
});
