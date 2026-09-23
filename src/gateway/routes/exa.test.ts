import { expect, test } from "bun:test";

import { exaCost, exaRoutes } from "./exa";
import { fakeBilling, fakeFetch, fakeSql, post } from "./test-harness";

test.each([
  [{ costDollars: { total: 0.003 } }, "0.003000000000"],
  [{ costDollars: { total: -1 } }, null],
  [{ costDollars: { total: "1" } }, null],
  [{}, null],
  [null, null],
])("exaCost(%j) is %p", (body, expected) => {
  expect(exaCost(body)?.toString() ?? null).toBe(expected);
});

const build = (respond: () => Response) => {
  const fake = fakeBilling();
  const { fetch, upstream } = fakeFetch(respond);
  const app = exaRoutes({ sql: fakeSql(), billing: fake.billing, enforceIdv: false, fetch, exaApiKey: "exa-key" });
  return { app, upstream, ...fake };
};

const searchResult = () => Response.json({ requestId: "r1", costDollars: { total: 0.002 }, results: [] });

const answerEvents = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
  'data: {"citations":[]}\n\n',
  'data: {"costDollars":{"total":0.004},"requestId":"exa-req-1"}\n\n',
];
const answerStream = () => {
  const parts = [...answerEvents];
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
  const { app, calls, upstream } = build(searchResult);
  const response = await app.handle(post("/proxy/v1/exa/search", { query: "hi", stream: true }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Streaming is only supported for Exa's answer endpoint" });
  expect(upstream).toEqual([]);
  expect(calls).toEqual([]);
});

test("forwards the Exa key and bills the reported cost", async () => {
  const { app, upstream, finalizes, settled } = build(searchResult);
  const response = await app.handle(post("/proxy/v1/exa/search", { query: "hi" }));
  expect(response.status).toBe(200);
  await response.text();
  expect(upstream[0]?.headers.get("x-api-key")).toBe("exa-key");
  await settled();
  expect(finalizes()[0]?.actualCostUsd.toString()).toBe("0.002000000000");
});

test("authenticates with x-api-key and no authorization header", async () => {
  const { app } = build(searchResult);
  const response = await app.handle(
    new Request("http://gateway.test/proxy/v1/exa/search", {
      method: "POST",
      headers: { "x-api-key": "sk-hc-v1-x", "content-type": "application/json" },
      body: JSON.stringify({ query: "hi" }),
    }),
  );
  expect(response.status).toBe(200);
});

test("streams answer events and bills the cost from the last event", async () => {
  const { app, finalizes, settled } = build(answerStream);
  const response = await app.handle(post("/proxy/v1/exa/answer", { query: "hi", stream: true }));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toBe(answerEvents.join(""));
  await settled();
  expect(finalizes()[0]?.actualCostUsd.toString()).toBe("0.004000000000");
  expect(finalizes()[0]?.providerRequestId).toBe("exa-req-1");
});

test("keeps reading after the client leaves so the answer is still billed", async () => {
  const { app, finalizes, settled } = build(answerStream);
  const response = await app.handle(post("/proxy/v1/exa/answer", { query: "hi", stream: true }));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  await settled();
  expect(finalizes()[0]?.actualCostUsd.toString()).toBe("0.004000000000");
});
