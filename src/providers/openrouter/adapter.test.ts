import { describe, expect, test } from "bun:test";

import { type Fetch, OpenRouterAdapter } from "./adapter";

const encoder = new TextEncoder();
const SSE = { "content-type": "text/event-stream" };
const JSON_TYPE = { "content-type": "application/json" };

const chunkedBody = (parts: string[], cancelled?: () => void) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
    cancel() {
      cancelled?.();
    },
  });

const execute = (
  response: () => Response,
  options: { stream?: boolean; maxCapturedBytes?: number; fetch?: Fetch } = {},
) =>
  new OpenRouterAdapter({
    maxCapturedBytes: options.maxCapturedBytes,
    fetch: options.fetch ?? (async () => response()),
  }).execute({
    endpoint: "chat/completions",
    body: options.stream ? { model: "test/model", stream: true } : { model: "test/model" },
    apiKey: "secret",
  });

const readOneThenCancel = async (response: Response) => {
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
};

const usageEvent = (id: string) =>
  `data: {"id":"${id}","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.001}}\n\n`;

describe("OpenRouterAdapter", () => {
  test("forwards SSE bytes unchanged and resolves terminal usage", async () => {
    const wireBody =
      ": OPENROUTER PROCESSING\r\n\r\n" +
      'data: {"id":"gen-1","choices":[{"delta":{"content":"hello"}}]}\r\n\r\n' +
      'data: {"id":"gen-1","usage":{"prompt_tokens":3,' +
      '"completion_tokens":2,"total_tokens":5,"cost":0.0004}}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const result = await execute(() => new Response(), {
      stream: true,
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ model: "test/model", stream: true });
        const parts = [wireBody.slice(0, 7), wireBody.slice(7, 53), wireBody.slice(53, 119), wireBody.slice(119)];
        return new Response(chunkedBody(parts), { headers: SSE });
      },
    });

    expect(await result.response.text()).toBe(wireBody);
    const completion = await result.completion;
    if (completion.state !== "complete") throw new Error("Expected usage");
    expect(completion.providerRequestId).toBe("gen-1");
    expect(completion.usage.costUsd.toString()).toBe("0.000400000000");
    expect(completion.responseBody).toBe(wireBody);
  });

  test("marks missing usage as uncertain for reconciliation", async () => {
    const result = await execute(
      () => new Response('data: {"id":"gen-unknown","choices":[]}\n\ndata: [DONE]\n\n', { headers: SSE }),
      { stream: true },
    );
    await result.response.text();
    const completion = await result.completion;
    expect(completion.state).toBe("uncertain");
    expect(completion.providerRequestId).toBe("gen-unknown");
  });

  test("cancels upstream and preserves the partial body", async () => {
    let cancelled = false;
    const result = await execute(
      () =>
        new Response(
          chunkedBody(['data: {"id":"gen-cancelled","choices":[]}\n\n', "data: never consumed\n\n"], () => {
            cancelled = true;
          }),
          { headers: SSE },
        ),
      { stream: true },
    );
    await readOneThenCancel(result.response);

    const completion = await result.completion;
    expect(cancelled).toBeTrue();
    if (completion.state !== "cancelled") throw new Error("Expected cancel");
    expect(completion.reason).toBe("client disconnected");
    expect(completion.providerRequestId).toBe("gen-cancelled");
    expect(completion.responseBody).toContain("gen-cancelled");
  });

  test("settles cancellation even when the upstream cancel rejects", async () => {
    const result = await execute(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(encoder.encode('data: {"id":"gen-gone"}\n\n'));
            },
            cancel() {
              throw new Error("socket already closed");
            },
          }),
          { headers: SSE },
        ),
      { stream: true },
    );
    await readOneThenCancel(result.response);

    const completion = await result.completion;
    expect(completion.state).toBe("cancelled");
    expect(completion.providerRequestId).toBe("gen-gone");
  });

  test("bills usage already received when the client cancels before [DONE]", async () => {
    const result = await execute(
      () => new Response(chunkedBody([usageEvent("gen-2"), "data: [DONE]\n\n"]), { headers: SSE }),
      { stream: true },
    );
    await readOneThenCancel(result.response);

    const completion = await result.completion;
    if (completion.state !== "complete") throw new Error("Expected usage");
    expect(completion.usage.costUsd.toString()).toBe("0.001000000000");
  });

  test("takes the generation id from X-Generation-Id when a non-streaming request is cancelled", async () => {
    const result = await execute(
      () =>
        new Response(chunkedBody(["   ", '{"id":"gen-body"']), {
          headers: { ...JSON_TYPE, "x-generation-id": "gen-header" },
        }),
    );
    await readOneThenCancel(result.response);

    const completion = await result.completion;
    expect(completion.state).toBe("cancelled");
    expect(completion.providerRequestId).toBe("gen-header");
  });

  test("stops capturing SSE bytes after the first chunk that overflows the cap", async () => {
    const wireBody = ": " + "x".repeat(98) + "\n\n" + usageEvent("gen-big") + "data: [DONE]\n\n";
    const part1 = wireBody.slice(0, 40);
    const result = await execute(
      () => new Response(chunkedBody([part1, wireBody.slice(40, 90), wireBody.slice(90)]), { headers: SSE }),
      { stream: true, maxCapturedBytes: 64 },
    );

    expect(await result.response.text()).toBe(wireBody);
    const completion = await result.completion;
    if (completion.state !== "complete") throw new Error("Expected usage");
    expect(completion.bodyCapture).toBe("truncated");
    expect(completion.responseBody).toBe(part1);
  });

  test("does not truncate a non-streaming JSON body over the cap", async () => {
    const wireBody = JSON.stringify({
      id: "gen-json-big",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.002 },
    });
    const result = await execute(() => new Response(wireBody, { headers: JSON_TYPE }), { maxCapturedBytes: 16 });

    expect(await result.response.text()).toBe(wireBody);
    const completion = await result.completion;
    if (completion.state !== "complete") throw new Error("Expected usage");
    expect(completion.bodyCapture).toBe("complete");
    expect(completion.responseBody).toBe(wireBody);
  });
});

describe("OpenRouterAdapter retries", () => {
  const sequence = (responses: Array<() => Response>) => {
    let calls = 0;
    const delays: number[] = [];
    const adapter = new OpenRouterAdapter({
      fetch: async () => responses[Math.min(calls++, responses.length - 1)]!(),
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const run = () => adapter.execute({ endpoint: "chat/completions", body: { model: "m" }, apiKey: "k" });
    return { calls: () => calls, delays, run };
  };
  const ok = () => Response.json({ id: "gen-ok", usage: { cost: 0.001 } });

  test("retries 429, 502 and 503 then returns the success", async () => {
    const { calls, delays, run } = sequence([
      () => new Response("busy", { status: 503 }),
      () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      ok,
    ]);
    expect((await run()).response.status).toBe(200);
    expect(calls()).toBe(3);
    expect(delays[0]).toBeGreaterThan(375);
    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[1]).toBe(2_000);
  });

  test("stops after three attempts and returns the last refusal", async () => {
    const { calls, run } = sequence([() => new Response("down", { status: 502 })]);
    const result = await run();
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).toBe("down");
    expect(calls()).toBe(3);
  });

  test.each([
    ["504", () => new Response("gateway timeout", { status: 504 })],
    ["400", () => new Response("bad", { status: 400 })],
    ["402 insufficient credits", () => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 })],
    ["429 with a long Retry-After", () => new Response("later", { status: 429, headers: { "retry-after": "30" } })],
  ])("does not retry %s", async (_name, response) => {
    const { calls, run } = sequence([response, ok]);
    expect((await run()).response.status).not.toBe(200);
    expect(calls()).toBe(1);
  });

  test("retries OpenRouter's transient in-flight budget 402", async () => {
    const { calls, run } = sequence([
      () =>
        Response.json(
          { error: { message: "busy", metadata: { limit_source: "openrouter_in_flight_budget" } } },
          { status: 402 },
        ),
      ok,
    ]);
    expect((await run()).response.status).toBe(200);
    expect(calls()).toBe(2);
  });
});
