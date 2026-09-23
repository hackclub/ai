import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import type { BillingEngine, Reservation } from "../billing/engine";
import { Usd } from "../billing/money";
import type { ModelCatalog } from "../models/catalog";
import type { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { blockedPrompts } from "../config/blocked-prompts";
import { BLOCKED_MESSAGE } from "./abuse";
import { proxyRoutes, withKeepAlive } from "./proxy";

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

/** Any query returns this principal: `authenticateApiKey` reads it, `touchApiKey` ignores it. */
const fakeSql = (async () => [
  {
    user_id: "user-1",
    api_key_id: "key-1",
    billing_account_id: "account-1",
    billing_account_status: "active",
    is_banned: false,
    is_idv_verified: true,
    skip_idv: false,
  },
]) as unknown as postgres.Sql;

const reservationFor = (requestId: string): Reservation => ({
  id: "reservation-1",
  requestId,
  accountId: "account-1",
  provider: "openrouter",
  providerRequestId: null,
  state: "finalized",
  estimatedCostUsd: "0.050000000000",
  actualCostUsd: "0.010000000000",
  unfundedCostUsd: "0.000000000000",
  expiresAt: new Date(Date.now() + 60_000),
});

/** Proxy routes over fakes that record each reserved estimate and adapter dispatch. */
const setup = (catalogEntry: unknown = null) => {
  const estimates: string[] = [];
  let dispatches = 0;
  const billing = {
    async reserve(input: { requestId: string; estimatedCostUsd: Usd }) {
      estimates.push(input.estimatedCostUsd.toString());
      return reservationFor(input.requestId);
    },
    finalize: async (input: { requestId: string }) => reservationFor(input.requestId),
    release: async (requestId: string) => reservationFor(requestId),
    markPendingReconciliation: async (requestId: string) => reservationFor(requestId),
  } as unknown as BillingEngine;
  const adapter = {
    async execute() {
      dispatches += 1;
      return {
        response: Response.json({ ok: true }),
        requestBody: "{}",
        completion: Promise.resolve({
          state: "complete" as const,
          providerRequestId: null,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: Usd.parse("0.01") },
          responseBody: JSON.stringify({ ok: true }),
          bodyCapture: "complete" as const,
        }),
      };
    },
  } as unknown as OpenRouterAdapter;
  const app = proxyRoutes({
    sql: fakeSql,
    billing,
    catalog: { find: async () => catalogEntry } as unknown as ModelCatalog,
    adapter,
    openRouterApiKey: "or-key",
    enforceIdv: false,
    reservationFallbackOutputTokens: 1_000,
  });
  const chat = (body: Record<string, unknown>) =>
    app.handle(
      new Request("http://gateway.test/proxy/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-hc-v1-test", "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [], ...body }),
      }),
    );
  return { chat, estimates, dispatches: () => dispatches };
};

describe("proxyRoutes", () => {
  test("returns an x-request-id header alongside the upstream body", async () => {
    const response = await setup().chat({ messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects a blocked prompt with 403 and never calls the adapter", async () => {
    const { chat, dispatches } = setup();
    const response = await chat({ messages: [{ role: "user", content: blockedPrompts[0] }] });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
    expect(dispatches()).toBe(0);
  });

  test("reserves the unknown-model hold when the listing has no usable pricing", async () => {
    const { chat, estimates } = setup({ id: "openai/gpt-4o-mini", pricing: {} });
    expect((await chat({})).status).toBe(200);
    expect(estimates).toEqual(["0.050000000000"]);
  });

  test("scales the hold by n and rejects n outside 1..8", async () => {
    const { chat, estimates } = setup();
    expect((await chat({ n: 3 })).status).toBe(200);
    expect(estimates).toEqual(["0.150000000000"]);
    for (const n of [0, 9, 1.5, "2"]) {
      const response = await chat({ n });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "n must be an integer from 1 to 8" });
    }
    expect(estimates).toHaveLength(1);
  });
});
