import { beforeAll, describe, expect, test } from "bun:test";

import { type Fetch, OpenRouterAdapter } from "../../providers/openrouter/adapter";
import { testDatabase } from "../../test/database";
import { exaRoutes } from "./exa";
import { imagesRoutes } from "./images";
import { ocrRoutes } from "./ocr";
import { createTestAccount, onlyBillingRecord, post, testBilling } from "./test-harness";

const { sql } = await testDatabase();

describe("provider routes with PostgreSQL", () => {
  const { billing, settlements, settled } = testBilling(sql);
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

  beforeAll(async () => {
    ({ userId, accountId, apiKey } = await createTestAccount(sql, "routes"));
  });

  test("exa: forwards and bills reported cost", async () => {
    const app = exaRoutes({ sql, billing, settlements, enforceIdv: false, fetch: fakeFetch, exaApiKey: "exa-key" });
    const requestId = "exa-request";
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

  test("ocr: redacts analytics and bills per page", async () => {
    const app = ocrRoutes({
      sql,
      billing,
      settlements,
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

  const ocrApp = (fetch: Fetch) =>
    ocrRoutes({ sql, billing, settlements, enforceIdv: false, fetch, mistralApiKey: "mistral-key", perPagePriceUsd: "0.002" });
  const ocrDocument = { type: "document_url", document_url: "https://x/a.pdf" };

  test("ocr: charges the hold for a success that reports no pages", async () => {
    const account = await createTestAccount(sql, "ocr-no-pages");
    const response = await ocrApp(async () => Response.json({ model: "mistral-ocr-latest" })).handle(
      post("/proxy/v1/ocr", { document: ocrDocument }, { authorization: `Bearer ${account.apiKey}` }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await settled();
    const record = await onlyBillingRecord(sql, account.accountId);
    expect([record.state, record.actualCostUsd, record.usageSource]).toEqual(["finalized", "0.050000000000", "fallback"]);
  });

  test("ocr: bills a request the client abandons before Mistral answers", async () => {
    const account = await createTestAccount(sql, "ocr-abandoned");
    const client = new AbortController();
    // Like the real fetch: an aborted signal rejects the call.
    const slowFetch: Fetch = (_input, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => resolve(Response.json({ pages: [{ index: 0 }, { index: 1 }] })), 50);
      });
    const request = new Request(post("/proxy/v1/ocr", { document: ocrDocument }, { authorization: `Bearer ${account.apiKey}` }), {
      signal: client.signal,
    });
    const pending = ocrApp(slowFetch).handle(request);
    setTimeout(() => client.abort(), 10);
    await pending.catch(() => {});
    await Bun.sleep(100);
    await settled();
    const record = await onlyBillingRecord(sql, account.accountId);
    expect([record.state, record.actualCostUsd]).toEqual(["finalized", "0.004000000000"]);
  });

  test("images: translates to chat completions and returns OpenAI shape", async () => {
    const app = imagesRoutes({
      sql,
      billing,
      settlements,
      enforceIdv: false,
      adapter: new OpenRouterAdapter({ baseUrl: "https://openrouter.test/api", fetch: fakeFetch }),
      openRouterApiKey: "or-key",
      allowedImageModels: ["img/model"],
      attributionHeaders: { "X-Title": "Test" },
    });
    const generationId = "gen-img";
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
