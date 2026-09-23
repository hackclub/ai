import { describe, expect, test } from "bun:test";

import { ModelCatalog } from "../models/catalog";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { blockedPrompts } from "../config/blocked-prompts";
import { BLOCKED_MESSAGE } from "./abuse";
import { proxyRoutes, withKeepAlive } from "./proxy";
import { testDatabase } from "../test/database";
import { billingRecords, createTestAccount, fakeFetch, onlyBillingRecord, testBilling } from "./routes/test-harness";

const { sql } = await testDatabase();

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
    adapter: new OpenRouterAdapter({ baseUrl: "https://openrouter.test/api", fetch: upstream.fetch }),
    openRouterApiKey: "or-key",
    enforceIdv: false,
    reservationFallbackOutputTokens: 1_000,
  });
  const chat = (body: Record<string, unknown>) =>
    app.handle(
      new Request("http://gateway.test/proxy/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${account.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [], ...body }),
      }),
    );
  const records = () => billingRecords(sql, account.accountId);
  const estimates = async () => (await records()).map((record) => record.estimatedCostUsd);
  return {
    chat,
    settled,
    records,
    record: () => onlyBillingRecord(sql, account.accountId),
    estimates,
    dispatches: () => upstream.upstream.length,
  };
};

describe("proxyRoutes", () => {
  test("returns an x-request-id header alongside the upstream body", async () => {
    const { chat, record, settled } = await setup();
    const response = await chat({ messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await response.json()) as ReturnType<typeof completionBody>;
    expect(body).toMatchObject({ ok: true });

    await settled();
    expect(await record()).toMatchObject({
      requestId,
      provider: "openrouter",
      state: "finalized",
      providerRequestId: body.id,
      actualCostUsd: "0.010000000000",
      usageSource: "provider_reported",
    });
  });

  test("rejects a blocked prompt with 403 and never calls the adapter", async () => {
    const { chat, dispatches, records } = await setup();
    const response = await chat({ messages: [{ role: "user", content: blockedPrompts[0] }] });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
    expect(dispatches()).toBe(0);
    expect(await records()).toEqual([]);
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
