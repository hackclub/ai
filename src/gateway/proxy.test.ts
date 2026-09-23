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

  test("leaves event streams untouched", () => {
    const response = new Response("data: x\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    expect(withKeepAlive(response, 5)).toBe(response);
  });
});

describe("proxyRoutes", () => {
  /**
   * A fake `postgres.Sql`: always resolves with one principal row, whatever
   * the query. `authenticateApiKey` reads it; `touchApiKey`'s fire-and-forget
   * update just resolves too. No real database is touched.
   */
  const fakeSql = (() => {
    const principalRow = {
      user_id: "user-1",
      api_key_id: "key-1",
      billing_account_id: "account-1",
      billing_account_status: "active",
      is_banned: false,
      is_idv_verified: true,
      skip_idv: false,
    };
    const tag = () => Promise.resolve([principalRow]);
    return tag as unknown as postgres.Sql;
  })();

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

  const fakeBilling = {
    async reserve(input: { requestId: string }) {
      return reservationFor(input.requestId);
    },
    async finalize(input: { requestId: string }) {
      return reservationFor(input.requestId);
    },
    async release(requestId: string) {
      return reservationFor(requestId);
    },
    async markPendingReconciliation(requestId: string) {
      return reservationFor(requestId);
    },
  } as unknown as BillingEngine;

  const fakeCatalog = {
    async find() {
      return null;
    },
  } as unknown as ModelCatalog;

  let adapterExecuteCalls = 0;

  const fakeAdapter = {
    async execute() {
      adapterExecuteCalls += 1;
      return {
        response: new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
        requestBody: "{}",
        completion: Promise.resolve({
          state: "complete" as const,
          providerRequestId: null,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            costUsd: Usd.parse("0.01"),
          },
          responseBody: JSON.stringify({ ok: true }),
          bodyCapture: "complete" as const,
        }),
      };
    },
  } as unknown as OpenRouterAdapter;

  const app = proxyRoutes({
    sql: fakeSql,
    billing: fakeBilling,
    catalog: fakeCatalog,
    adapter: fakeAdapter,
    openRouterApiKey: "or-key",
    enforceIdv: false,
    reservationFallbackOutputTokens: 1_000,
  });

  test("returns an x-request-id header matching the billing reservation's request id", async () => {
    const response = await app.handle(
      new Request("http://gateway.test/proxy/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-hc-v1-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects a blocked prompt with 403 and never calls the adapter", async () => {
    const callsBefore = adapterExecuteCalls;
    const response = await app.handle(
      new Request("http://gateway.test/proxy/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-hc-v1-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: blockedPrompts[0] }],
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
    expect(adapterExecuteCalls).toBe(callsBefore);
  });

  test("reserves the unknown-model hold when the listing has no usable pricing", async () => {
    const recordedEstimates: string[] = [];
    const catalogWithoutPricing = {
      async find() {
        return { id: "openai/gpt-4o-mini", pricing: {} };
      },
    } as unknown as ModelCatalog;
    const billingRecordingEstimates = {
      ...fakeBilling,
      async reserve(input: { requestId: string; estimatedCostUsd: Usd }) {
        recordedEstimates.push(input.estimatedCostUsd.toString());
        return reservationFor(input.requestId);
      },
    } as unknown as BillingEngine;
    const appWithoutPricing = proxyRoutes({
      sql: fakeSql,
      billing: billingRecordingEstimates,
      catalog: catalogWithoutPricing,
      adapter: fakeAdapter,
      openRouterApiKey: "or-key",
      enforceIdv: false,
      reservationFallbackOutputTokens: 1_000,
    });

    const response = await appWithoutPricing.handle(
      new Request("http://gateway.test/proxy/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-hc-v1-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(recordedEstimates).toEqual(["0.050000000000"]);
  });

  test("scales the hold by n and rejects n outside 1..8", async () => {
    const recordedEstimates: string[] = [];
    const recording = proxyRoutes({
      sql: fakeSql,
      billing: {
        ...fakeBilling,
        async reserve(input: { requestId: string; estimatedCostUsd: Usd }) {
          recordedEstimates.push(input.estimatedCostUsd.toString());
          return reservationFor(input.requestId);
        },
      } as unknown as BillingEngine,
      catalog: fakeCatalog,
      adapter: fakeAdapter,
      openRouterApiKey: "or-key",
      enforceIdv: false,
      reservationFallbackOutputTokens: 1_000,
    });
    const send = (n: unknown) =>
      recording.handle(
        new Request("http://gateway.test/proxy/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer sk-hc-v1-test", "content-type": "application/json" },
          body: JSON.stringify({ model: "some/model", messages: [], n }),
        }),
      );

    expect((await send(3)).status).toBe(200);
    expect(recordedEstimates).toEqual(["0.150000000000"]);
    for (const n of [0, 9, 1.5, "2"]) {
      const response = await send(n);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        "n must be an integer from 1 to 8",
      );
    }
    expect(recordedEstimates).toHaveLength(1);
  });
});
