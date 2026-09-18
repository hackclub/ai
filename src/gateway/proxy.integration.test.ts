import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../analytics/worker";
import { createUser, issueApiKey } from "../auth/users";
import { createApp } from "../app";
import { BillingEngine } from "../billing/engine";
import { ModelCatalog } from "../models/catalog";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;

const runId = crypto.randomUUID().slice(0, 8);
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
      id: "test/pricey",
      pricing: { prompt: "1", completion: "1" },
      top_provider: { max_completion_tokens: 1000 },
    },
  ],
});

describe("proxy routes with PostgreSQL", () => {
  let sql: Sql | undefined;
  let accountId: string;
  let apiKey: string;
  let userId: string;
  const upstreamCalls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  let nextUpstream: () => Response = () => new Response(null, { status: 500 });

  const fakeFetch: typeof fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) return modelListing.clone();
    if (url.endsWith("/v1/embeddings/models")) return Response.json({ data: [] });
    upstreamCalls.push({
      url,
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return nextUpstream();
  }) as typeof fetch;

  const app = () => {
    if (!sql) throw new Error("Missing database");
    return createApp({
      proxy: {
        sql,
        billing: new BillingEngine(sql),
        catalog: new ModelCatalog({
          baseUrl: "https://upstream.test/api",
          apiKey: "upstream-key",
          fetch: fakeFetch,
        }),
        adapter: new OpenRouterAdapter({
          baseUrl: "https://upstream.test/api",
          fetch: fakeFetch,
        }),
        openRouterApiKey: "upstream-key",
        enforceIdv: false,
        reservationFallbackOutputTokens: 8192,
        // Small enough to fit the 0.01 USD test allowance.
        unknownModelReservationUsd: "0.001",
        attributionHeaders: { "X-Title": "Test" },
      },
    });
  };

  const call = (path: string, init: RequestInit = {}) =>
    app().handle(new Request(`http://gateway.test${path}`, init));

  const chat = (body: unknown, key = apiKey) =>
    call("/proxy/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 4 });
    await migrateJobQueue(databaseUrl);
    const user = await createUser(sql, {
      slackId: `U-proxy-${runId}`,
      name: "Proxy Test",
      dailyAllowanceUsd: "0.01",
    });
    userId = user.userId;
    accountId = user.billingAccountId;
    apiKey = (await issueApiKey(sql, userId, "test")).key;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`
      DELETE FROM request_event_outbox
      WHERE payload->>'account_id' = ${accountId}
    `;
    const reservations = sql`
      SELECT id FROM billing_reservations WHERE account_id = ${accountId}::uuid
    `;
    await sql`DELETE FROM billing_ledger_entries WHERE account_id = ${accountId}::uuid`;
    for (const table of [
      "billing_reservation_funding_holds",
      "billing_reservation_credit_holds",
      "billing_reservation_limit_holds",
    ]) {
      await sql`DELETE FROM ${sql(table)} WHERE reservation_id IN (${reservations})`;
    }
    await sql`DELETE FROM billing_reservations WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_windows WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_policies WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_accounts WHERE id = ${accountId}::uuid`;
    await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
    await sql.end();
  });

  integrationTest("lists models without authentication", async () => {
    const response = await call("/proxy/v1/models");
    expect(response.status).toBe(200);
    const listing = (await response.json()) as { data: Array<{ id: string }> };
    expect(listing.data.map((model) => model.id)).toEqual([
      "test/chat",
      "test/pricey",
    ]);
  });

  integrationTest("rejects missing and unknown keys", async () => {
    const missing = await chat({ model: "test/chat" }, "");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Authentication required" });

    const unknown = await chat({ model: "test/chat" }, "sk-hc-v1-nope");
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "Authentication failed" });
  });

  integrationTest("rejects malformed bodies but forwards unlisted models", async () => {
    const notJson = await call("/proxy/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: "nope",
    });
    expect(notJson.status).toBe(400);
    expect(upstreamCalls.length).toBe(0);

    // There is no allowlist: a model missing from the listing still reaches
    // OpenRouter, which is the authority on whether it exists.
    nextUpstream = () =>
      Response.json({ error: { message: "no such model" } }, { status: 400 });
    const unlisted = await chat({ model: "test/missing" });
    expect(unlisted.status).toBe(400);
    expect(upstreamCalls.at(-1)?.body.model).toBe("test/missing");
  });

  integrationTest(
    "streams a completion through unchanged and finalizes billing",
    async () => {
      if (!sql) throw new Error("Missing database");
      const generationId = `gen-proxy-${runId}`;
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
      expect(response.headers.get("x-upstream")).toBe("yes");
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

  integrationTest("refuses requests the allowance cannot cover", async () => {
    const callsBefore = upstreamCalls.length;
    const response = await chat({
      model: "test/pricey",
      messages: [{ role: "user", content: "expensive" }],
    });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: string }).error).toContain(
      "Spending limit reached",
    );
    expect(upstreamCalls.length).toBe(callsBefore);
  });
});
