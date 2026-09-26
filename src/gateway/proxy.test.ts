import { describe, expect, test } from "bun:test";

import { AnalyticsQueries } from "../analytics/queries";
import { ModelCatalog } from "../models/catalog";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";
import abuseRules from "../test/abuse-rules.json";
import { BANNED_MESSAGE } from "../auth/users";
import { BLOCKED_MESSAGE } from "./abuse";
import { proxyRoutes, withKeepAlive } from "./proxy";
import { testClickHouse, testDatabase } from "../test/database";
import { billingRecords, createTestAccount, fakeFetch, onlyBillingRecord, testBilling } from "./routes/test-harness";

const { sql } = await testDatabase();
const analytics = new AnalyticsQueries((await testClickHouse()).clickhouse);

const encoder = new TextEncoder();

describe("withKeepAlive", () => {
  test("pads with whitespace until the first upstream byte", async () => {
    let release: () => void = () => {};
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        controller.enqueue(encoder.encode('{"ok":true}'));
        controller.close();
      },
    });
    const wrapped = withKeepAlive(
      new Response(upstream, { headers: { "content-type": "application/json" } }),
      5,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const text = await wrapped.text();
    expect(text.startsWith(" ")).toBeTrue();
    expect(JSON.parse(text)).toEqual({ ok: true });
  });

  test("forwards client cancellation to the upstream body", async () => {
    let cancelledWith: unknown = null;
    const upstream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const wrapped = withKeepAlive(
      new Response(upstream, { headers: { "content-type": "application/json" } }),
      5,
    );
    const reader = wrapped.body?.getReader();
    await reader?.cancel("client disconnected");
    expect(cancelledWith).toBe("client disconnected");
  });
});

/** An OpenRouter completion body with authoritative usage and a unique generation id. */
const completionBody = () => ({
  id: `gen-${crypto.randomUUID()}`,
  ok: true,
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
});

/**
 * Proxy routes over the real engine, a fresh account, and the real catalog
 * and adapter talking to a faked OpenRouter. The listing holds
 * `catalogEntry` when given, else nothing.
 */
const setup = async (catalogEntry: unknown = null) => {
  const account = await createTestAccount(sql, crypto.randomUUID());
  const { billing, settlements, settled } = testBilling(sql);
  const listing = fakeFetch(() => Response.json({ data: catalogEntry ? [catalogEntry] : [] }));
  const upstream = fakeFetch(() => Response.json(completionBody()));
  const app = proxyRoutes({
    sql,
    billing,
    settlements,
    catalog: new ModelCatalog({
      baseUrl: "https://openrouter.test/api",
      apiKey: "or-key",
      fetch: listing.fetch as typeof fetch,
    }),
    usageStats: (accountId) => analytics.userStats(accountId),
    adapter: new OpenRouterAdapter({ baseUrl: "https://openrouter.test/api", fetch: upstream.fetch }),
    openRouterApiKey: "or-key",
    enforceIdv: false,
    reservationFallbackOutputTokens: 1_000,
  });
  const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://gateway.test/proxy/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${account.apiKey}`, "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [], ...body }),
      }),
    );
  const records = () => billingRecords(sql, account.accountId);
  const estimates = async () => (await records()).map((record) => record.estimatedCostUsd);
  const abuseEvents = () => sql<{ kind: string; rule: string; enforced: boolean; endpoint: string; user_agent: string }[]>`
    SELECT kind, rule, enforced, endpoint, user_agent FROM abuse_events WHERE user_id = ${account.userId}::uuid ORDER BY id
  `;
  const banned = async () => (await sql<{ is_banned: boolean }[]>`SELECT is_banned FROM users WHERE id = ${account.userId}::uuid`)[0]!.is_banned;
  return {
    chat,
    abuseEvents,
    banned,
    settled,
    records,
    record: () => onlyBillingRecord(sql, account.accountId),
    estimates,
    dispatches: () => upstream.upstream.length,
  };
};

describe("proxyRoutes", () => {
  test("rejects a blocked prompt with 403, records the refusal and never calls the adapter", async () => {
    const { chat, dispatches, records, abuseEvents } = await setup();
    const response = await chat(
      { messages: [{ role: "system", content: abuseRules.prompts["Test agent"][0] }, { role: "user", content: "hi" }] },
      { "user-agent": "curl/8.7" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
    expect(dispatches()).toBe(0);
    expect(await records()).toEqual([]);
    expect([...(await abuseEvents())]).toEqual([
      { kind: "prompt", rule: "Test agent", enforced: true, endpoint: "/proxy/v1/chat/completions", user_agent: "curl/8.7" },
    ]);
  });

  test("screens only after authentication, so the rules cannot be probed without a key", async () => {
    const { chat } = await setup();
    const response = await chat(
      { messages: [{ role: "system", content: abuseRules.prompts["Test agent"][0] }] },
      { authorization: "", "user-agent": "Blocked-Test-Agent/1.0" },
    );
    expect(response.status).toBe(401);
  });

  test("a shadow rule records its match and lets the request through", async () => {
    const { chat, abuseEvents, settled, record } = await setup();
    const response = await chat({ messages: [{ role: "user", content: "hi" }] }, { "x-title": "Shadow-Test-App" });
    expect(response.status).toBe(200);
    await response.text();
    await settled();
    expect((await record()).state).toBe("finalized");
    expect([...(await abuseEvents())]).toMatchObject([{ kind: "app", rule: "shadow-test-app", enforced: false }]);
  });

  test("bans the account on its first request from a blocked IP and answers like an outage", async () => {
    const { chat, abuseEvents, banned, dispatches, records } = await setup();
    const response = await chat({ messages: [{ role: "user", content: "hi" }] }, { "cf-connecting-ip": "198.51.100.7", "user-agent": "python-requests/2.34.2" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
    expect(dispatches()).toBe(0);
    expect(await records()).toEqual([]);
    expect(await banned()).toBeTrue();
    expect([...(await abuseEvents())]).toEqual([
      { kind: "ip", rule: "198.51.100.7", enforced: true, endpoint: "/proxy/v1/chat/completions", user_agent: "python-requests/2.34.2" },
    ]);

    // The account stays banned from any other address.
    const next = await chat({ messages: [{ role: "user", content: "hi" }] }, { "cf-connecting-ip": "203.0.113.50" });
    expect(next.status).toBe(403);
    expect(await next.json()).toEqual({ error: BANNED_MESSAGE });
  });

  test("an IP rule ending in a separator matches the whole prefix", async () => {
    const { chat, banned } = await setup();
    // Mobile carriers hand out a fresh address in the same /64 on every connection.
    const response = await chat({ messages: [{ role: "user", content: "hi" }] }, { "cf-connecting-ip": "2001:db8:77:1:9f2:44ab:1c0:e3" });
    expect(response.status).toBe(500);
    expect(await banned()).toBeTrue();
  });

  test("an IP rule without a separator matches only that address, and a shadow IP only records", async () => {
    const { chat, abuseEvents, banned, settled } = await setup();
    const neighbour = await chat({ messages: [{ role: "user", content: "hi" }] }, { "cf-connecting-ip": "198.51.100.70" });
    expect(neighbour.status).toBe(200);
    await neighbour.text();
    const shadowed = await chat({ messages: [{ role: "user", content: "hi" }] }, { "cf-connecting-ip": "198.51.100.8" });
    expect(shadowed.status).toBe(200);
    await shadowed.text();
    await settled();
    expect(await banned()).toBeFalse();
    expect([...(await abuseEvents())]).toMatchObject([{ kind: "ip", rule: "198.51.100.8", enforced: false }]);
  });

  test("records the request shape for the behavioural scan", async () => {
    const { chat, settled, record } = await setup();
    const response = await chat({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
    });
    await response.text();
    await settled();
    expect((await record()).event?.attributes).toMatchObject({ tool_count: "1", message_count: "3" });
  });

  test("reserves the unknown-model hold when the listing has no usable pricing", async () => {
    const { chat, estimates, settled } = await setup({ id: "openai/gpt-4o-mini", pricing: {} });
    const response = await chat({});
    expect(response.status).toBe(200);
    await response.text();
    await settled();
    expect(await estimates()).toEqual(["0.050000000000"]);
  });

  test("scales the hold by n and rejects n outside 1..8", async () => {
    const { chat, estimates, settled } = await setup();
    const accepted = await chat({ n: 3 });
    expect(accepted.status).toBe(200);
    await accepted.text();
    await settled();
    expect(await estimates()).toEqual(["0.150000000000"]);
    for (const n of [0, 9, 1.5, "2"]) {
      const response = await chat({ n });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "n must be an integer from 1 to 8" });
    }
    expect(await estimates()).toHaveLength(1);
  });
});
