import { expect, test } from "bun:test";

import { exaCost, exaRoutes } from "./exa";
import { testDatabase } from "../../test/database";
import { billingRecords, createTestAccount, fakeFetch, onlyBillingRecord, post, testBilling } from "./test-harness";

const { sql } = await testDatabase();

test.each([
  [{ costDollars: { total: 0.003 } }, "0.003000000000"],
  [{ costDollars: { total: -1 } }, null],
  [{ costDollars: { total: "1" } }, null],
  [{}, null],
  [null, null],
])("exaCost(%j) is %p", (body, expected) => {
  expect(exaCost(body)?.toString() ?? null).toBe(expected);
});

/** Exa routes over the real engine, a fresh account, and a faked Exa upstream. */
const build = async (respond: () => Response) => {
  const account = await createTestAccount(sql, crypto.randomUUID());
  const { billing, settlements, settled } = testBilling(sql);
  const { fetch, upstream } = fakeFetch(respond);
  const app = exaRoutes({ sql, billing, settlements, enforceIdv: false, fetch, exaApiKey: "exa-key" });
  const authorized = (path: string, body: unknown) =>
    app.handle(post(path, body, { authorization: `Bearer ${account.apiKey}` }));
  return {
    app,
    account,
    authorized,
    upstream,
    settled,
    records: () => billingRecords(sql, account.accountId),
    record: () => onlyBillingRecord(sql, account.accountId),
  };
};

// Exa request ids are unique per provider in the database, as upstream.
const searchResult = () =>
  Response.json({ requestId: `exa-search-${crypto.randomUUID()}`, costDollars: { total: 0.002 }, results: [] });

const answerEvents = (requestId: string) => [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
  'data: {"citations":[]}\n\n',
  `data: {"costDollars":{"total":0.004},"requestId":"${requestId}"}\n\n`,
];
const answerStream = (requestId: string) => () => {
  const parts = answerEvents(requestId);
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(1);
        const part = parts.shift();
        if (part === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(part));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

test("rejects streaming on endpoints other than answer", async () => {
  const { authorized, records, upstream } = await build(searchResult);
  const response = await authorized("/proxy/v1/exa/search", { query: "hi", stream: true });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Streaming is only supported for Exa's answer endpoint" });
  expect(upstream).toEqual([]);
  expect(await records()).toEqual([]);
});

test("forwards the Exa key and bills the reported cost", async () => {
  const { authorized, upstream, record, settled } = await build(searchResult);
  const response = await authorized("/proxy/v1/exa/search", { query: "hi" });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstream[0]?.headers.get("x-api-key")).toBe("exa-key");
  await settled();
  expect(await record()).toMatchObject({
    state: "finalized",
    provider: "exa",
    actualCostUsd: "0.002000000000",
    usageSource: "provider_reported",
  });
});

test("authenticates with x-api-key and no authorization header", async () => {
  const { app, account, record, settled } = await build(searchResult);
  const response = await app.handle(
    new Request("http://gateway.test/proxy/v1/exa/search", {
      method: "POST",
      headers: { "x-api-key": account.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: "hi" }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
  await settled();
  expect((await record()).state).toBe("finalized");
});

test("streams answer events and bills the cost from the last event", async () => {
  const requestId = `exa-answer-${crypto.randomUUID()}`;
  const { authorized, record, settled } = await build(answerStream(requestId));
  const response = await authorized("/proxy/v1/exa/answer", { query: "hi", stream: true });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toBe(answerEvents(requestId).join(""));
  await settled();
  const finalized = await record();
  expect(finalized).toMatchObject({ state: "finalized", actualCostUsd: "0.004000000000", providerRequestId: requestId });
  expect(finalized.event).toMatchObject({ streamed: true, provider_request_id: requestId });
});

test("keeps reading after the client leaves so the answer is still billed", async () => {
  const { authorized, record, settled } = await build(answerStream(`exa-answer-${crypto.randomUUID()}`));
  const response = await authorized("/proxy/v1/exa/answer", { query: "hi", stream: true });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  await settled();
  expect(await record()).toMatchObject({ state: "finalized", actualCostUsd: "0.004000000000" });
});
