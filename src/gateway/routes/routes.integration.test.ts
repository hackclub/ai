import { afterAll, beforeAll, describe, expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../../analytics/worker";
import { BillingEngine } from "../../billing/engine";
import { type Fetch, OpenRouterAdapter } from "../../providers/openrouter/adapter";
import { integrationDatabaseUrl, integrationTestFor } from "../../test/integration-db";
import { exaRoutes } from "./exa";
import { imagesRoutes } from "./images";
import { ocrRoutes } from "./ocr";
import { createTestAccount, post } from "./test-harness";

const databaseUrl = integrationDatabaseUrl("BILLING_TEST_DATABASE_URL");
const integrationTest = integrationTestFor(databaseUrl);
const runId = crypto.randomUUID().slice(0, 8);

describe("provider routes with PostgreSQL", () => {
  let sql: Sql | undefined;
  let billing: BillingEngine | undefined;
  let userId: string;
  let accountId: string;
  let apiKey: string;
  const upstream: Array<{ url: string; body: unknown; headers: Headers }> = [];
  let nextResponse: () => Response = () => new Response("{}", { status: 500 });
  const fakeFetch: Fetch = async (input, init) => {
    upstream.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    });
    return nextResponse();
  };

  const send = (app: { handle: (request: Request) => Promise<Response> }, path: string, body: unknown) =>
    app.handle(post(path, body, { authorization: `Bearer ${apiKey}` }));

  const waitForState = async (providerRequestId: string, state: string) => {
    if (!sql) throw new Error("Missing database");
    let row: { state: string; actual_cost_usd: string | null } | undefined;
    for (let attempt = 0; attempt < 50 && row?.state !== state; attempt += 1) {
      [row] = await sql<{ state: string; actual_cost_usd: string | null }[]>`
        SELECT state, actual_cost_usd::text FROM billing_reservations
        WHERE provider_request_id = ${providerRequestId}
      `;
      if (row?.state !== state) await Bun.sleep(20);
    }
    return row;
  };

  let cleanup = async () => {};

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 4 });
    billing = new BillingEngine(sql);
    await migrateJobQueue(databaseUrl);
    ({ userId, accountId, apiKey, cleanup } = await createTestAccount(sql, `routes-${runId}`));
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup();
    await sql.end();
  });

  integrationTest("exa: forwards and bills reported cost", async () => {
    if (!sql || !billing) throw new Error("Missing database");
    const app = exaRoutes({ sql, billing, enforceIdv: false, fetch: fakeFetch, exaApiKey: "exa-key" });
    const requestId = `exa-${runId}`;
    nextResponse = () => Response.json({ requestId, results: [], costDollars: { total: 0.005 } });
    const response = await send(app, "/proxy/v1/exa/search", { query: "six seven mango" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { requestId: string }).requestId).toBe(requestId);
    const call = upstream.at(-1);
    expect(call?.url).toBe("https://api.exa.ai/search");
    expect(call?.headers.get("x-api-key")).toBe("exa-key");
    expect(call?.body).toEqual({ query: "six seven mango" });

    const row = await waitForState(requestId, "finalized");
    expect(row?.actual_cost_usd).toBe("0.005000000000");
  });

  integrationTest("ocr: redacts analytics and bills per page", async () => {
    if (!sql || !billing) throw new Error("Missing database");
    const app = ocrRoutes({
      sql,
      billing,
      enforceIdv: false,
      fetch: fakeFetch,
      mistralApiKey: "mistral-key",
      perPagePriceUsd: "0.002",
    });
    nextResponse = () =>
      Response.json({
        model: "mistral-ocr-latest",
        pages: [{ index: 0, markdown: "secret text" }, { index: 1, markdown: "more" }, { index: 2 }],
      });
    const response = await send(app, "/proxy/v1/ocr", {
      document: { type: "document_url", document_url: "https://x/a.pdf" },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { pages: unknown[] }).pages).toHaveLength(3);
    expect(upstream.at(-1)?.url).toBe("https://api.mistral.ai/v1/ocr");
    expect(upstream.at(-1)?.headers.get("authorization")).toBe("Bearer mistral-key");

    let job: { payload: { response_body: string; billed_cost_usd: string } } | undefined;
    for (let attempt = 0; attempt < 50 && !job; attempt += 1) {
      [job] = await sql<{ payload: { response_body: string; billed_cost_usd: string } }[]>`
        SELECT payload FROM request_event_outbox
        WHERE payload->>'account_id' = ${accountId} AND payload->>'endpoint' = 'ocr'
      `;
      if (!job) await Bun.sleep(20);
    }
    expect(job?.payload.billed_cost_usd).toBe("0.006000000000");
    expect(job?.payload.response_body).not.toContain("secret text");
    expect(JSON.parse(job?.payload.response_body ?? "{}").pages[0].markdown_length).toBe(11);
  });

  integrationTest("images: translates to chat completions and returns OpenAI shape", async () => {
    if (!sql || !billing) throw new Error("Missing database");
    const app = imagesRoutes({
      sql,
      billing,
      enforceIdv: false,
      adapter: new OpenRouterAdapter({ baseUrl: "https://openrouter.test/api", fetch: fakeFetch }),
      openRouterApiKey: "or-key",
      allowedImageModels: ["img/model"],
      attributionHeaders: { "X-Title": "Test" },
    });
    const generationId = `gen-img-${runId}`;
    nextResponse = () =>
      Response.json({
        id: generationId,
        choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,QUJD" } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.01 },
      });
    const response = await send(app, "/proxy/v1/images/generations", {
      prompt: "a cat",
      size: "1024x1792",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { created: number; data: unknown[] };
    expect(body.data).toEqual([{ b64_json: "QUJD" }]);
    const call = upstream.at(-1);
    expect(call?.url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(call?.headers.get("authorization")).toBe("Bearer or-key");
    expect(call?.body).toEqual({
      model: "img/model",
      messages: [{ role: "user", content: "a cat" }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "9:16" },
      user: `user_${userId}`,
      usage: { include: true },
    });
    const row = await waitForState(generationId, "finalized");
    expect(row?.actual_cost_usd).toBe("0.010000000000");
  });
});
