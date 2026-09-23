import { expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { jevCost, jevModelLabel, jevRoutes, jevTokens } from "./jev";
import { testDatabase } from "../../test/database";
import { billingRecords, createTestAccount, fakeFetch, onlyBillingRecord, post, testBilling } from "./test-harness";

const { sql } = await testDatabase();

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

/** Jev routes over the real engine, a fresh account, and a faked TypeSafe upstream. */
const build = async (respond: () => Response, overrides: Overrides = {}) => {
  const account = await createTestAccount(sql, crypto.randomUUID());
  const { billing, settlements, settled } = testBilling(sql);
  const { fetch, upstream } = fakeFetch(respond);
  const app = jevRoutes({
    sql,
    billing,
    settlements,
    enforceIdv: false,
    fetch,
    typesafeApiKey: "ts-key",
    ...overrides,
  });
  const authorization = `Bearer ${account.apiKey}`;
  const authorized = (path: string, body: unknown) => app.handle(post(path, body, { authorization }));
  return {
    app,
    authorization,
    authorized,
    upstream,
    settled,
    records: () => billingRecords(sql, account.accountId),
    record: () => onlyBillingRecord(sql, account.accountId),
  };
};

test("rejects models outside the Jev family before reserving", async () => {
  const { authorized, records, upstream } = await build(() => Response.json(successBody));
  const response = await authorized("/proxy/v1/jev/systemone", { model: "gpt-4o", state: "x" });
  expect(response.status).toBe(400);
  expect(await records()).toEqual([]);
  expect(upstream).toEqual([]);
});

test("forwards systemone with the default model and bills reported input tokens", async () => {
  const { authorized, upstream, record, settled } = await build(() => Response.json(successBody));
  const response = await authorized("/proxy/v1/jev/systemone", { state: "hello" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(successBody);

  expect(upstream[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(upstream[0]?.headers.get("authorization")).toBe("Bearer ts-key");
  expect(JSON.parse(upstream[0]?.body ?? "")).toEqual({ state: "hello", model: "jev-latest" });

  await settled();
  const finalized = await record();
  expect(finalized).toMatchObject({
    state: "finalized",
    provider: "typesafe",
    actualCostUsd: "0.042000000000",
    usageSource: "provider_reported",
  });
  expect(finalized.event).toMatchObject({
    // Logged under the versioned id the response reported, not the alias requested.
    model: "jev/jev-1.13.0",
    input_tokens: 1_000_000,
    output_tokens: 48,
    billed_cost_usd: "0.042000000000",
  });
});

test("keeps the requested model and honours configured prices on the /v1 prefix", async () => {
  const { authorized, upstream, record, settled } = await build(
    () => Response.json({ ...successBody, usage: { input_tokens: 2_000_000, output_tokens: 0 } }),
    { inputPricePerMillionTokensUsd: "0.1", reservationUsd: "0.5" },
  );
  const response = await authorized("/proxy/v1/jev/v1/systemone", { state: "x", model: "jev-preview" });
  expect(response.status).toBe(200);
  expect(JSON.parse(upstream[0]?.body ?? "")).toEqual({ state: "x", model: "jev-preview" });

  await settled();
  expect(await record()).toMatchObject({
    state: "finalized",
    estimatedCostUsd: "0.500000000000",
    actualCostUsd: "0.200000000000",
  });
});

test("an upstream rejection finalizes at zero under the requested model label", async () => {
  const { authorized, record, settled } = await build(() => Response.json({ error: "bad state" }, { status: 422 }));
  const response = await authorized("/proxy/v1/jev/systemone", { state: "x" });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "bad state" });

  await settled();
  const finalized = await record();
  expect(finalized).toMatchObject({ state: "finalized", actualCostUsd: "0.000000000000" });
  expect(finalized.event).toMatchObject({ model: "jev/jev-latest", outcome: "provider_error", http_status: 422 });
});

test("marks a success without usage pending reconciliation", async () => {
  const { authorized, record, settled } = await build(() => Response.json({ model: "jev-1.13.0", answers: {} }));
  const response = await authorized("/proxy/v1/jev/systemone", { state: "x" });
  expect(response.status).toBe(200);
  await response.text();
  await settled();
  expect(await record()).toMatchObject({ state: "pending_reconciliation", actualCostUsd: null, event: null });
});

test("passes models through unbilled on both prefixes, filtering headers", async () => {
  const listing = { models: [{ name: "jev-latest", description: "alias", release_date: "2026-01-01" }] };
  const { app, authorization, upstream, records } = await build(() =>
    Response.json(listing, { headers: { "content-encoding": "gzip", "x-upstream": "1" } }),
  );
  for (const path of ["/proxy/v1/jev/models", "/proxy/v1/jev/v1/models"]) {
    const response = await app.handle(new Request(`http://gateway.test${path}`, { headers: { authorization } }));
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
  expect(await records()).toEqual([]);
});
