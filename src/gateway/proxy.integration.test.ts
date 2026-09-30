import { beforeAll, describe, expect, test } from "bun:test";

import { issueApiKey } from "../auth/api-keys";
import { createUser } from "../auth/users";
import { createApp } from "../app";
import { billingRecords, createTestAccount, testBilling } from "./routes/test-harness";
import { AnalyticsQueries } from "../analytics/queries";
import { drainRequestEvents } from "../analytics/request-events";
import { expireStaleReservations } from "../billing/reconciliation";
import { ModelCatalog } from "../models/catalog";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { testBlobStore, testClickHouse, testDatabase } from "../test/database";

const { sql } = await testDatabase();
const { clickhouse } = await testClickHouse();
const blobStore = await testBlobStore();
const analytics = new AnalyticsQueries(clickhouse);

const encoder = new TextEncoder();
const streamOf = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
  });

const modelListing = Response.json({
  data: [
    {
      id: "test/chat",
      pricing: { prompt: "0.000001", completion: "0.000002", request: "0" },
      top_provider: { max_completion_tokens: 1000 },
    },
    {
      id: "test/free",
      pricing: { prompt: "0", completion: "0" },
      top_provider: { max_completion_tokens: 1000 },
    },
    {
      id: "test/vision",
      pricing: { prompt: "0.00001", completion: "0.00001", request: "0" },
      top_provider: { max_completion_tokens: 1000 },
    },
    {
      id: "test/tiered",
      pricing: {
        prompt: "0.000001",
        completion: "0.000001",
        overrides: [{ min_prompt_tokens: 1000, prompt: "0.001", completion: "0.001" }],
      },
      top_provider: { max_completion_tokens: 1000 },
    },
    {
      id: "test/pricey",
      pricing: { prompt: "1", completion: "1" },
      top_provider: { max_completion_tokens: 1000 },
    },
  ],
});

describe("proxy routes with PostgreSQL", () => {
  let apiKey: string;
  let userId: string;
  const upstreamCalls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  let nextUpstream: () => Response = () => new Response(null, { status: 500 });

  const fakeFetch: typeof fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) return modelListing.clone();
    if (url.endsWith("/v1/embeddings/models")) {
      return Response.json({ data: [{ id: "test/embed", pricing: { prompt: "0.0000001", completion: "0" } }] });
    }
    upstreamCalls.push({
      url,
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return nextUpstream();
  }) as typeof fetch;

  const billing = testBilling(sql);
  const app = (overrides: { reservationTtlMs?: number; fetch?: typeof fetch } = {}) =>
    createApp({
      proxy: {
        sql,
        ...billing,
        catalog: new ModelCatalog({
          baseUrl: "https://upstream.test/api",
          apiKey: "upstream-key",
          fetch: fakeFetch,
        }),
        usageStats: (accountId) => analytics.userStats(accountId),
        adapter: new OpenRouterAdapter({
          baseUrl: "https://upstream.test/api",
          fetch: overrides.fetch ?? fakeFetch,
        }),
        reservationTtlMs: overrides.reservationTtlMs,
        openRouterApiKey: "upstream-key",
        enforceIdv: false,
        reservationFallbackOutputTokens: 8192,
        // Small enough to fit the 0.01 USD test allowance.
        unknownModelReservationUsd: "0.001",
        attributionHeaders: { "X-Title": "Test" },
      },
    });

  const call = (path: string, init: RequestInit = {}) =>
    app().handle(new Request(`http://gateway.test${path}`, init));

  const chat = (body: unknown, key = apiKey) =>
    call("/proxy/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const user = await createUser(sql, {
      slackId: "U-proxy",
      name: "Proxy Test",
      dailyAllowanceUsd: "0.01",
    });
    userId = user.userId;
    apiKey = (await issueApiKey(sql, userId, "test")).key;
  });

  test("lists models without authentication", async () => {
    const response = await call("/proxy/v1/models");
    expect(response.status).toBe(200);
    const listing = (await response.json()) as { data: Array<{ id: string }> };
    expect(listing.data.map((model) => model.id)).toEqual([
      "test/chat",
      "test/free",
      "test/vision",
      "test/tiered",
      "test/pricey",
      "test/embed",
    ]);
  });

  test("lists only embedding models under /embeddings/models", async () => {
    const response = await call("/proxy/v1/embeddings/models");
    expect(response.status).toBe(200);
    const listing = (await response.json()) as { data: Array<{ id: string }> };
    expect(listing.data.map((model) => model.id)).toEqual(["test/embed"]);
  });

  test("reports the key owner's lifetime usage from ClickHouse", async () => {
    const owner = await createUser(sql, { slackId: `U-stats-${crypto.randomUUID()}`, dailyAllowanceUsd: "1" });
    const ownerKey = (await issueApiKey(sql, owner.userId, "stats")).key;
    const stats = async (key: string) =>
      call("/proxy/v1/stats", { headers: { authorization: `Bearer ${key}` } });

    expect((await call("/proxy/v1/stats")).status).toBe(401);

    for (const [prompt, completion] of [[10, 4], [6, 2]] as const) {
      nextUpstream = () =>
        Response.json({
          id: `gen-${crypto.randomUUID()}`,
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost: 0.00001 },
        });
      const response = await chat({ model: "test/chat", messages: [{ role: "user", content: "hi" }] }, ownerKey);
      expect(response.status).toBe(200);
      await response.text();
    }
    await billing.settled();
    await drainRequestEvents({ sql, clickhouse, blobStore, batchSize: 1_000 });

    // Other tests' requests are in ClickHouse too; only this key's owner counts.
    const response = await stats(ownerKey);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      totalRequests: 2,
      totalTokens: 22,
      totalPromptTokens: 16,
      totalCompletionTokens: 6,
    });
  });

  test("rejects missing and unknown keys", async () => {
    const missing = await chat({ model: "test/chat" }, "");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Authentication required" });

    const unknown = await chat({ model: "test/chat" }, "sk-hc-v1-nope");
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "Authentication failed" });
  });

  test("rejects malformed bodies and unlisted models before reserving", async () => {
    const account = await createTestAccount(sql, "unlisted");
    const callsBefore = upstreamCalls.length;
    const notJson = await call("/proxy/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${account.apiKey}` },
      body: "nope",
    });
    expect(notJson.status).toBe(400);

    const unlisted = await chat({ model: "test/missing" }, account.apiKey);
    expect(unlisted.status).toBe(400);
    expect(await unlisted.json()).toEqual({ error: "test/missing is not a valid model ID" });
    expect(upstreamCalls.length).toBe(callsBefore);
    expect(await billingRecords(sql, account.accountId)).toEqual([]);
  });

  test("forwards routing variants of listed models unchanged", async () => {
    const account = await createTestAccount(sql, "variant");
    nextUpstream = () =>
      Response.json({
        id: "gen-variant",
        model: "test/chat",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000005 },
      });
    const response = await chat({ model: "test/chat:nitro", messages: [{ role: "user", content: "hi" }] }, account.apiKey);
    expect(response.status).toBe(200);
    await response.text();
    await billing.settled();

    expect(upstreamCalls.at(-1)?.body.model).toBe("test/chat:nitro");
    const [record] = await billingRecords(sql, account.accountId);
    expect(record?.state).toBe("finalized");
    expect(record?.actualCostUsd).toBe("0.000005000000");
    expect(record?.event?.model).toBe("test/chat:nitro");
    // Reserved at the base model's price, not the unknown-model hold.
    expect(record?.estimatedCostUsd).not.toBe("0.001000000000");
  });

  test(
    "streams a completion through unchanged and finalizes billing",
    async () => {
      const generationId = "gen-proxy";
      const wire =
        `data: {"id":"${generationId}","choices":[{"delta":{"content":"hi"}}]}\n\n` +
        `data: {"id":"${generationId}","usage":{"prompt_tokens":2,"completion_tokens":1,"cost":0.000003}}\n\n` +
        "data: [DONE]\n\n";
      nextUpstream = () =>
        new Response(streamOf([wire.slice(0, 20), wire.slice(20)]), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "content-encoding": "identity",
            "x-upstream": "yes",
          },
        });

      const response = await chat({
        model: "test/chat",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("x-upstream")).toBeNull();
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe(wire);

      const upstream = upstreamCalls.at(-1);
      expect(upstream?.url).toBe("https://upstream.test/api/v1/chat/completions");
      expect(upstream?.headers.get("authorization")).toBe("Bearer upstream-key");
      expect(upstream?.headers.get("x-title")).toBe("Test");
      expect(upstream?.body.user).toBe(`user_${userId}`);
      expect(upstream?.body.usage).toEqual({ include: true });
      expect(upstream?.body.max_tokens).toBeUndefined();

      // Settlement runs after the body is consumed; poll briefly.
      let row: { state: string; actual_cost_usd: string } | undefined;
      for (let attempt = 0; attempt < 50 && row?.state !== "finalized"; attempt += 1) {
        [row] = await sql<{ state: string; actual_cost_usd: string }[]>`
          SELECT state, actual_cost_usd::text
          FROM billing_reservations
          WHERE provider_request_id = ${generationId}
        `;
        if (row?.state !== "finalized") await Bun.sleep(20);
      }
      expect(row?.state).toBe("finalized");
      expect(row?.actual_cost_usd).toBe("0.000003000000");
    },
  );

  const chatAs = (account: { apiKey: string }, endpoint: string, body: unknown) =>
    call(`/proxy/v1/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const reply = (cost: number) => () =>
    Response.json({
      id: `gen-${crypto.randomUUID()}`,
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost },
    });

  test("reserves for the priciest model a request may fall back to", async () => {
    const account = await createTestAccount(sql, "fallback-models");
    const callsBefore = upstreamCalls.length;
    const messages = [{ role: "user", content: "hi" }];

    const pricey = await chatAs(account, "chat/completions", { model: "test/free", models: ["test/pricey"], max_tokens: 1, messages });
    expect(pricey.status).toBe(402);
    const unlisted = await chatAs(account, "chat/completions", { model: "test/free", models: ["test/missing"], messages });
    expect(unlisted.status).toBe(400);
    expect(await unlisted.json()).toEqual({ error: "test/missing is not a valid model ID" });
    expect(upstreamCalls.length).toBe(callsBefore);
    expect(await billingRecords(sql, account.accountId)).toEqual([]);
  });

  test("holds for web search, which the listing does not price", async () => {
    const account = await createTestAccount(sql, "web-search");
    nextUpstream = reply(0.0004);
    const messages = [{ role: "user", content: "hi" }];
    for (const body of [
      { model: "test/free:online", messages },
      { model: "test/free", plugins: [{ id: "web" }], messages },
      { model: "test/free", web_search_options: {}, messages },
      { model: "test/free", tools: [{ type: "openrouter:web_search" }], messages },
    ]) {
      const response = await chatAs(account, "chat/completions", body);
      expect(response.status).toBe(200);
      await response.text();
    }
    await billing.settled();
    const records = await billingRecords(sql, account.accountId);
    expect(records.map((record) => [record.estimatedCostUsd, record.actualCostUsd])).toEqual(
      Array(4).fill(["0.001000000000", "0.000400000000"]),
    );
  });

  test("reserves the output cap the endpoint honours", async () => {
    const account = await createTestAccount(sql, "output-cap");
    nextUpstream = reply(0.000001);
    const messages = [{ role: "user", content: "hi" }];
    for (const [endpoint, body] of [
      // 12 prompt tokens; 500 of test/chat's 1000 output tokens.
      ["chat/completions", { model: "test/chat", max_tokens: 1, max_completion_tokens: 500, messages }],
      // A zero cap is no cap: all 1000 output tokens.
      ["chat/completions", { model: "test/chat", max_tokens: 0, messages }],
      // Responses honours only max_output_tokens; 4 prompt tokens.
      ["responses", { model: "test/chat", max_tokens: 1, input: "hi" }],
    ] as const) {
      const response = await chatAs(account, endpoint, body);
      expect(response.status).toBe(200);
      await response.text();
    }
    await billing.settled();
    const records = await billingRecords(sql, account.accountId);
    expect(records.map((record) => record.estimatedCostUsd)).toEqual([
      "0.001012000000",
      "0.002012000000",
      "0.002004000000",
    ]);
  });

  test("reserves images at what the model was last billed per image", async () => {
    const account = await createTestAccount(sql, "images");
    const callsBefore = upstreamCalls.length;
    const link = "https://images.test/p?key=attachments%2Fsingle";
    const linkedPhotos = (count: number) => ({
      model: "test/vision",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            ...Array.from({ length: count }, () => ({ type: "image_url", image_url: { url: link } })),
            { type: "text", text: "check my answers" },
          ],
        },
      ],
    });

    // Nothing billed for this model yet, so ten short links are held as ten
    // expensive photos and refused on the $1 allowance.
    expect((await chatAs(account, "chat/completions", linkedPhotos(10))).status).toBe(402);
    expect(upstreamCalls.length).toBe(callsBefore);

    // One embedded photo, however long its base64, that the provider bills as 2,000 prompt tokens.
    nextUpstream = () =>
      Response.json({
        id: `gen-${crypto.randomUUID()}`,
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 2_000, completion_tokens: 1, cost: 0.02001 },
      });
    const embedded = await chatAs(account, "chat/completions", {
      model: "test/vision",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${"A".repeat(2_000_000)}` } }],
        },
      ],
    });
    expect(embedded.status).toBe(200);
    await embedded.text();
    await billing.settled();

    // Now held at about 2,000 tokens a photo: $0.20 for ten.
    const linked = await chatAs(account, "chat/completions", linkedPhotos(10));
    expect(linked.status).toBe(200);
    await linked.text();
    // Sixty Responses-style photos come to $1.20, past the allowance.
    const responses = await chatAs(account, "responses", {
      model: "test/vision",
      max_output_tokens: 1,
      input: [{ role: "user", content: Array.from({ length: 60 }, () => ({ type: "input_image", image_url: link })) }],
    });
    expect(responses.status).toBe(402);
    await billing.settled();

    const records = await billingRecords(sql, account.accountId);
    expect(records.map((record) => [record.state, record.actualCostUsd])).toEqual([
      ["finalized", "0.020010000000"],
      ["finalized", "0.020010000000"],
    ]);
    const tenPhotos = Number(records[1]?.estimatedCostUsd);
    expect(tenPhotos).toBeGreaterThanOrEqual(0.19);
    expect(tenPhotos).toBeLessThan(0.21);
  });

  test("reserves a long prompt at the model's long-context price", async () => {
    const account = await createTestAccount(sql, "tiered");
    nextUpstream = reply(0.000002);
    const callsBefore = upstreamCalls.length;

    const short = await chatAs(account, "chat/completions", {
      model: "test/tiered",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(short.status).toBe(200);
    await short.text();
    // About 2,000 prompt tokens: past the 1,000-token tier, where a token costs $0.001.
    const long = await chatAs(account, "chat/completions", {
      model: "test/tiered",
      max_tokens: 1,
      messages: [{ role: "user", content: "x".repeat(8_000) }],
    });
    expect(long.status).toBe(402);
    expect(upstreamCalls.length).toBe(callsBefore + 1);
    await billing.settled();
    const records = await billingRecords(sql, account.accountId);
    expect(records.map((record) => [record.state, record.actualCostUsd])).toEqual([["finalized", "0.000002000000"]]);
  });

  test("stops a generation whose client left before OpenRouter answered, and keeps it for reconciliation", async () => {
    const account = await createTestAccount(sql, "abandoned");
    const generationId = `gen-${crypto.randomUUID()}`;
    let upstreamCancelled = false;
    // Like the real fetch: an aborted signal rejects the call. OpenRouter answers
    // after 200 ms and then streams until it is cancelled.
    const slowFetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/v1/models")) return fakeFetch(input as string, init);
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => {
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Bun.sleep(20);
              controller.enqueue(encoder.encode(`data: {"id":"${generationId}","choices":[{"delta":{"content":"tok"}}]}\n\n`));
            },
            cancel() {
              upstreamCancelled = true;
            },
          });
          resolve(new Response(stream, { headers: { "content-type": "text/event-stream", "x-generation-id": generationId } }));
        }, 200);
      });
    }) as typeof fetch;
    const gateway = app({ fetch: slowFetch });
    const server = Bun.serve({ port: 0, fetch: (request) => gateway.handle(request) });
    try {
      const client = new AbortController();
      const response = fetch(`http://localhost:${server.port}/proxy/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${account.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "test/chat", stream: true, messages: [{ role: "user", content: "hi" }] }),
        signal: client.signal,
      });
      setTimeout(() => client.abort(), 50);
      await response.catch(() => null);
      await Bun.sleep(400);
      await billing.settled();
    } finally {
      server.stop(true);
    }
    expect(upstreamCancelled).toBeTrue();
    const [record] = await billingRecords(sql, account.accountId);
    expect([record?.state, record?.providerRequestId]).toEqual(["pending_reconciliation", generationId]);
  });

  test("keeps the hold of a stream still being read when its reservation expires", async () => {
    const account = await createTestAccount(sql, "slow-reader");
    const generationId = `gen-${crypto.randomUUID()}`;
    const { promise: rest, resolve: sendRest } = Promise.withResolvers<void>();
    nextUpstream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`data: {"id":"${generationId}","choices":[{"delta":{"content":"hi"}}]}\n\n`));
            await rest;
            controller.enqueue(
              encoder.encode(`data: {"id":"${generationId}","usage":{"prompt_tokens":2,"completion_tokens":1,"cost":0.000003}}\n\ndata: [DONE]\n\n`),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream", "x-generation-id": generationId } },
      );
    const response = await app({ reservationTtlMs: 200 }).handle(
      new Request("http://gateway.test/proxy/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${account.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "test/chat", stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await Bun.sleep(300);
    await expireStaleReservations({ sql, billing: billing.billing });
    expect((await billingRecords(sql, account.accountId))[0]?.state).toBe("pending_reconciliation");

    sendRest();
    while (!(await reader.read()).done);
    await billing.settled();
    const [record] = await billingRecords(sql, account.accountId);
    expect([record?.state, record?.actualCostUsd]).toEqual(["finalized", "0.000003000000"]);
  });

  test("refuses requests the allowance cannot cover", async () => {
    const callsBefore = upstreamCalls.length;
    const response = await chat({
      model: "test/pricey",
      messages: [{ role: "user", content: "expensive" }],
    });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: string }).error).toContain(
      "Spending limit reached",
    );
    expect(upstreamCalls.length).toBe(callsBefore);
  });
});
