import { describe, expect, test } from "bun:test";

import { AdminUsers } from "../admin/users";
import { AnalyticsQueries } from "../analytics/queries";
import { drainRequestEvents } from "../analytics/request-events";
import { createApp } from "../app";
import { issueApiKey } from "../auth/api-keys";
import { createSessions } from "../auth/sessions";
import { BANNED_MESSAGE, createUser } from "../auth/users";
import { DiscountBook } from "../billing/discounts";
import { BillingEngine } from "../billing/engine";
import { GlobalPolicies } from "../billing/policies";
import { reconcilePendingReservations } from "../billing/reconciliation";
import { ModelCatalog } from "../models/catalog";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { openRouterProvider } from "../providers/openrouter/provider";
import { providerRegistry } from "../providers/provider";
import { testBlobStore, testClickHouse, testDatabase } from "../test/database";
import { adminApiRoutes } from "./admin-api";
import { billingRecords, testBilling } from "./routes/test-harness";

const { sql } = await testDatabase();
const { clickhouse } = await testClickHouse();
const blobStore = await testBlobStore();
const analytics = new AnalyticsQueries(clickhouse);

const BASE_URL = "http://gateway.test";
const sessions = createSessions({ sql, secureCookies: false });
const billing = testBilling(sql);
const discounts = new DiscountBook(sql);

// Each model reserves about $0.002: 1,000 output tokens at $0.000002.
const modelListing = () =>
  Response.json({
    data: ["anthropic/claude-test", "anthropic/claude-pricey", "openai/gpt-test"].map((id) => ({
      id,
      pricing: { prompt: "0.000001", completion: "0.000002", request: "0" },
      top_provider: { max_completion_tokens: 1000 },
    })),
  });

let nextUpstream: () => Response = () => new Response(null, { status: 500 });
const fakeFetch = (async (input: string | URL | Request) => {
  if (String(input).endsWith("/v1/models")) return modelListing();
  if (String(input).endsWith("/v1/embeddings/models")) return Response.json({ data: [] });
  return nextUpstream();
}) as typeof fetch;

const app = createApp({
  proxy: {
    sql,
    ...billing,
    discounts,
    catalog: new ModelCatalog({ baseUrl: "https://upstream.test/api", apiKey: "upstream-key", fetch: fakeFetch }),
    usageStats: (accountId) => analytics.userStats(accountId),
    adapter: new OpenRouterAdapter({ baseUrl: "https://upstream.test/api", fetch: fakeFetch }),
    openRouterApiKey: "upstream-key",
    enforceIdv: false,
    reservationFallbackOutputTokens: 1000,
  },
  routes: [
    adminApiRoutes({
      baseUrl: BASE_URL,
      sessions,
      users: new AdminUsers(sql),
      policies: new GlobalPolicies(sql),
      discounts,
      servedBy: () => analytics.servedBy(),
    }),
  ],
});

let people = 0;
/** A user with an API key and, when `allowanceUsd` is set, an allowance of their own. */
const person = async (options: { admin?: boolean; allowanceUsd?: string } = {}) => {
  const user = await createUser(sql, { slackId: `U-admin-${++people}`, dailyAllowanceUsd: options.allowanceUsd });
  if (options.admin) await sql`UPDATE users SET is_admin = true WHERE id = ${user.userId}::uuid`;
  return {
    userId: user.userId,
    accountId: user.billingAccountId,
    apiKey: (await issueApiKey(sql, user.userId, "test")).key,
    cookie: (await sessions.start(user.userId)).split(";")[0] ?? "",
  };
};

const admin = await person({ admin: true });

const adminCall = (method: string, path: string, body?: unknown, options: { cookie?: string; origin?: string } = {}) =>
  app.handle(
    new Request(`${BASE_URL}/api/admin${path}`, {
      method,
      headers: {
        cookie: options.cookie ?? admin.cookie,
        origin: options.origin ?? BASE_URL,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const chat = async (apiKey: string, model = "anthropic/claude-test", extra: Record<string, unknown> = {}) => {
  const response = await app.handle(
    new Request(`${BASE_URL}/proxy/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
    }),
  );
  await response.text();
  await billing.settled();
  return response;
};

/** OpenRouter's non-streaming reply, naming the upstream that served it. */
const reply = (cost: number, upstream: { provider: string; model?: string }) => () =>
  Response.json({
    id: `gen-${crypto.randomUUID()}`,
    model: upstream.model ?? "anthropic/claude-test",
    provider: upstream.provider,
    choices: [{ message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, cost },
  });

const fundingWindows = async (accountId: string) => [
  ...(await sql<{ policy_id: string; granted: string; committed: string }[]>`
    SELECT policy_id, granted_usd::text AS granted, committed_usd::text AS committed
    FROM billing_funding_windows WHERE account_id = ${accountId}::uuid
  `),
];

describe("admin API access", () => {
  test("refuses anyone but a signed-in, unbanned admin on this origin", async () => {
    const member = await person();
    const unauthenticated = await app.handle(new Request(`${BASE_URL}/api/admin/discounts`, { method: "POST", body: "{}" }));
    expect(unauthenticated.status).toBe(401);
    expect((await adminCall("POST", "/discounts", {}, { cookie: member.cookie })).status).toBe(403);
    expect((await adminCall("POST", "/discounts", {}, { origin: "https://evil.test" })).status).toBe(403);

    const banned = await person({ admin: true });
    await sql`UPDATE users SET is_banned = true WHERE id = ${banned.userId}::uuid`;
    const response = await adminCall("POST", "/discounts", {}, { cookie: banned.cookie });
    expect([response.status, await response.json()]).toEqual([403, { error: BANNED_MESSAGE }]);
    expect(await sql`SELECT * FROM admin_audit_events`).toHaveLength(0);
  });
});

describe("global policies", () => {
  let allowanceId: string;
  const first = person();
  const second = person();

  test("one global allowance funds every account without its own, each in its own window", async () => {
    const created = await adminCall("POST", "/policies/funding", {
      name: "Daily allowance",
      cadence: "day",
      amountUsd: "0.01",
      enabled: true,
    });
    expect(created.status).toBe(200);
    allowanceId = ((await created.json()) as { id: string }).id;

    const [a, b] = await Promise.all([first, second]);
    nextUpstream = reply(0.008, { provider: "Anthropic" });
    expect((await chat(a.apiKey)).status).toBe(200);
    // A shared window would have only $0.002 left; B's own has the full $0.01.
    nextUpstream = reply(0.001, { provider: "Anthropic" });
    expect((await chat(b.apiKey)).status).toBe(200);

    expect(await fundingWindows(a.accountId)).toEqual([{ policy_id: allowanceId, granted: "0.010000000000", committed: "0.008000000000" }]);
    expect(await fundingWindows(b.accountId)).toEqual([{ policy_id: allowanceId, granted: "0.010000000000", committed: "0.001000000000" }]);
  });

  test("an allowance of the account's own replaces the global one rather than adding to it", async () => {
    const own = await person({ allowanceUsd: "0.001" });
    nextUpstream = reply(0.0001, { provider: "Anthropic" });
    const response = await chat(own.apiKey);
    expect(response.status).toBe(402);
    expect(await billingRecords(sql, own.accountId)).toEqual([]);
  });

  test("a new amount applies to the current period, never below what was already spent", async () => {
    const [a, b] = await Promise.all([first, second]);
    expect((await adminCall("PATCH", `/policies/funding/${allowanceId}`, { amountUsd: "0.005" })).status).toBe(200);

    expect((await fundingWindows(a.accountId))[0]?.granted).toBe("0.008000000000");
    expect((await fundingWindows(b.accountId))[0]?.granted).toBe("0.005000000000");
    nextUpstream = reply(0.001, { provider: "Anthropic" });
    expect((await chat(a.apiKey)).status).toBe(402);
    expect((await chat(b.apiKey)).status).toBe(200);

    expect((await adminCall("PATCH", `/policies/funding/${allowanceId}`, { amountUsd: "0.01" })).status).toBe(200);
    expect((await fundingWindows(a.accountId))[0]?.granted).toBe("0.010000000000");
  });

  test("a global limit caps every account at once, until it is turned off", async () => {
    const b = await second;
    const created = await adminCall("POST", "/policies/limit", {
      name: "OpenRouter top-up wait",
      cadence: "day",
      amountUsd: "0.0001",
      enabled: true,
    });
    const limitId = ((await created.json()) as { id: string }).id;

    nextUpstream = reply(0.001, { provider: "Anthropic" });
    expect((await chat(b.apiKey)).status).toBe(429);

    expect((await adminCall("PATCH", `/policies/limit/${limitId}`, { enabled: false })).status).toBe(200);
    expect((await chat(b.apiKey)).status).toBe(200);

    // A request allowed under the limit opens a window, which deleting must keep pointing at it.
    expect((await adminCall("PATCH", `/policies/limit/${limitId}`, { enabled: true, amountUsd: "1" })).status).toBe(200);
    expect((await chat(b.apiKey)).status).toBe(200);
    const removed = await adminCall("DELETE", `/policies/limit/${limitId}`);
    expect(await removed.json()).toEqual({ outcome: "ended" });
    const [ended] = await sql<{ enabled: boolean; ended: boolean }[]>`
      SELECT enabled, effective_until <= now() AS ended FROM billing_limit_policies WHERE id = ${limitId}::uuid
    `;
    expect(ended).toEqual({ enabled: false, ended: true });

    const actions = await sql<{ action: string; actor_user_id: string }[]>`
      SELECT action, actor_user_id FROM admin_audit_events WHERE target_id = ${limitId} ORDER BY id
    `;
    expect(actions.map((event) => event.action)).toEqual(["policy_created", "policy_changed", "policy_changed", "policy_ended"]);
    expect(actions.every((event) => event.actor_user_id === admin.userId)).toBeTrue();
  });

  test("a limit of the account's own does not lift a global limit", async () => {
    const own = await person({ allowanceUsd: "1" });
    await sql`
      INSERT INTO billing_limit_policies (account_id, name, cadence, limit_usd)
      VALUES (${own.accountId}::uuid, 'Generous cap', 'day', 100)
    `;
    const created = await adminCall("POST", "/policies/limit", { name: "Safety cap", cadence: "day", amountUsd: "0.0001", enabled: true });
    const { id } = (await created.json()) as { id: string };

    try {
      nextUpstream = reply(0.001, { provider: "Anthropic" });
      expect((await chat(own.apiKey)).status).toBe(429);
      expect(await billingRecords(sql, own.accountId)).toEqual([]);
    } finally {
      expect((await adminCall("DELETE", `/policies/limit/${id}`)).status).toBe(200);
    }
  });

  test("an unused policy is deleted outright", async () => {
    const created = await adminCall("POST", "/policies/funding", {
      name: "Never used",
      cadence: "month",
      amountUsd: "5",
      enabled: false,
    });
    const { id } = (await created.json()) as { id: string };
    expect(await (await adminCall("DELETE", `/policies/funding/${id}`)).json()).toEqual({ outcome: "deleted" });
    expect(await sql`SELECT 1 FROM billing_funding_policies WHERE id = ${id}::uuid`).toHaveLength(0);
  });

  test("rejects a cadence a policy cannot have", async () => {
    const response = await adminCall("POST", "/policies/funding", { name: "Forever", cadence: "lifetime", amountUsd: "1", enabled: true });
    expect(response.status).toBe(400);
  });
});

describe("bans", () => {
  test("a ban stops the user's API keys on their next request and is recorded with its reason", async () => {
    const user = await person({ allowanceUsd: "1" });
    nextUpstream = reply(0.0001, { provider: "Anthropic" });

    expect((await adminCall("POST", `/users/${user.userId}/ban`, { banned: true, reason: "Reselling keys" })).status).toBe(200);
    const refused = await app.handle(
      new Request(`${BASE_URL}/proxy/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-test", messages: [] }),
      }),
    );
    expect([refused.status, await refused.json()]).toEqual([403, { error: BANNED_MESSAGE }]);

    expect((await adminCall("POST", `/users/${user.userId}/ban`, { banned: false })).status).toBe(200);
    expect((await chat(user.apiKey)).status).toBe(200);

    const history = await sql<{ action: string; reason: string | null }[]>`
      SELECT action, reason FROM admin_audit_events WHERE target_type = 'user' AND target_id = ${user.userId} ORDER BY id
    `;
    expect(history.map((event) => ({ ...event }))).toEqual([
      { action: "user_banned", reason: "Reselling keys" },
      { action: "user_unbanned", reason: null },
    ]);
  });

  test("an admin cannot ban themselves", async () => {
    const response = await adminCall("POST", `/users/${admin.userId}/ban`, { banned: true });
    expect([response.status, await response.json()]).toEqual([400, { error: "You cannot ban yourself" }]);
  });
});

describe("discounts", () => {
  const user = person({ allowanceUsd: "1" });
  let discountId: string;

  test("may only name an upstream that has served requests", async () => {
    const body = { modelPattern: "anthropic/*", servedBy: "Anthropic", percentOff: "100", note: "Our credits", enabled: true };
    const refused = await adminCall("POST", "/discounts", body);
    expect([refused.status, await refused.json()]).toEqual([
      400,
      { error: "No request has been served by Anthropic in the last 30 days" },
    ]);

    // Requests record their upstream; once one reaches ClickHouse it can be named.
    await clickhouse.command({ query: "TRUNCATE TABLE request_events" });
    nextUpstream = reply(0.002, { provider: "Anthropic" });
    expect((await chat((await user).apiKey)).status).toBe(200);
    await drainRequestEvents({ sql, clickhouse, blobStore, batchSize: 1_000 });

    const created = await adminCall("POST", "/discounts", body);
    expect(created.status).toBe(200);
    discountId = ((await created.json()) as { id: string }).id;
  });

  test("an upstream discount applies only to requests that upstream served", async () => {
    const { apiKey, accountId } = await user;
    const before = (await billingRecords(sql, accountId)).length;

    nextUpstream = reply(0.003, { provider: "Anthropic" });
    await chat(apiKey);
    nextUpstream = reply(0.003, { provider: "Amazon Bedrock" });
    await chat(apiKey);

    const [anthropic, bedrock] = (await billingRecords(sql, accountId)).slice(before);
    expect(anthropic?.actualCostUsd).toBe("0.000000000000");
    expect(anthropic?.event).toMatchObject({
      provider_cost_usd: "0.003000000000",
      billed_cost_usd: "0.000000000000",
      attributes: { served_by: "Anthropic", discount_id: discountId, discount_percent_off: "100.00" },
    });
    expect(bedrock?.actualCostUsd).toBe("0.003000000000");
    expect(bedrock?.event?.attributes).toMatchObject({ served_by: "Amazon Bedrock" });
    expect(bedrock?.event?.attributes).not.toHaveProperty("discount_id");
  });

  test("a stream that names its upstream only before the usage chunk is still discounted", async () => {
    const { apiKey, accountId } = await user;
    const id = `gen-${crypto.randomUUID()}`;
    nextUpstream = () =>
      new Response(
        `data: {"id":"${id}","model":"anthropic/claude-test","provider":"Anthropic","choices":[{"delta":{"content":"hi"}}]}\n\n` +
          `data: {"id":"${id}","usage":{"prompt_tokens":2,"completion_tokens":1,"cost":0.004}}\n\n` +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    await chat(apiKey, "anthropic/claude-test", { stream: true });
    const record = (await billingRecords(sql, accountId)).at(-1);
    expect([record?.providerRequestId, record?.actualCostUsd]).toEqual([id, "0.000000000000"]);
  });

  test("a model discount applies to the model that ran, never to a fallback", async () => {
    const { apiKey, accountId } = await user;
    const created = await adminCall("POST", "/discounts", { modelPattern: "anthropic/claude-test", percentOff: "50", enabled: true });
    expect(created.status).toBe(200);

    // The discounted model ran.
    nextUpstream = reply(0.002, { provider: "Google", model: "anthropic/claude-test" });
    await chat(apiKey);
    // A caller who forces a fallback to another model, even the same vendor's, pays its full price.
    nextUpstream = reply(0.002, { provider: "Google", model: "anthropic/claude-pricey" });
    await chat(apiKey, "anthropic/claude-test", { models: ["anthropic/claude-pricey"] });
    nextUpstream = reply(0.002, { provider: "OpenAI", model: "openai/gpt-test" });
    await chat(apiKey, "anthropic/claude-test", { models: ["openai/gpt-test"] });

    const [ran, sameVendor, otherVendor] = (await billingRecords(sql, accountId)).slice(-3);
    expect(ran?.actualCostUsd).toBe("0.001000000000");
    expect(sameVendor?.actualCostUsd).toBe("0.002000000000");
    expect(otherVendor?.actualCostUsd).toBe("0.002000000000");
  });

  test("reconciliation applies the discount for the upstream the generation record names", async () => {
    const { apiKey, accountId } = await user;
    const id = `gen-${crypto.randomUUID()}`;
    // The stream ends without usage, so the request waits for reconciliation.
    nextUpstream = () =>
      new Response(`data: {"id":"${id}","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    await chat(apiKey, "anthropic/claude-test", { stream: true });
    expect((await billingRecords(sql, accountId)).at(-1)?.state).toBe("pending_reconciliation");

    const generation = (async () =>
      Response.json({
        data: { id, model: "anthropic/claude-test", total_cost: 0.006, provider_name: "Anthropic", native_tokens_prompt: 2, native_tokens_completion: 1 },
      })) as unknown as typeof fetch;
    const result = await reconcilePendingReservations({
      sql,
      billing: new BillingEngine(sql),
      providers: providerRegistry([openRouterProvider({ apiKey: "upstream-key", baseUrl: "https://upstream.test/api", fetch: generation })]),
      discounts,
      notFoundGraceMs: 0,
    });
    expect(result.finalized).toBe(1);
    const record = (await billingRecords(sql, accountId)).at(-1);
    expect(record?.actualCostUsd).toBe("0.000000000000");
    expect(record?.event).toMatchObject({ provider_cost_usd: "0.006000000000", attributes: { served_by: "Anthropic", discount_id: discountId } });
  });

  test("deleting a discount bills the next request in full", async () => {
    const { apiKey, accountId } = await user;
    for (const discount of await discounts.list()) {
      expect((await adminCall("DELETE", `/discounts/${discount.id}`)).status).toBe(200);
    }
    nextUpstream = reply(0.003, { provider: "Anthropic" });
    await chat(apiKey);
    expect((await billingRecords(sql, accountId)).at(-1)?.actualCostUsd).toBe("0.003000000000");
  });
});
