import { describe, expect, test } from "bun:test";

import { OpenRouterAdapter } from "./adapter";

const encoder = new TextEncoder();

const chunkedBody = (parts: string[], cancelled?: () => void) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(part));
      }
    },
    cancel() {
      cancelled?.();
    },
  });

describe("OpenRouterAdapter", () => {
  test("forwards SSE bytes unchanged and resolves terminal usage", async () => {
    const wireBody =
      ": OPENROUTER PROCESSING\r\n\r\n" +
      'data: {"id":"gen-1","choices":[{"delta":{"content":"hello"}}]}\r\n\r\n' +
      'data: {"id":"gen-1","usage":{"prompt_tokens":3,' +
      '"completion_tokens":2,"total_tokens":5,"cost":0.0004}}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const adapter = new OpenRouterAdapter({
      fetch: (async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "test/model",
          stream: true,
        });
        return new Response(
          chunkedBody([
            wireBody.slice(0, 7),
            wireBody.slice(7, 53),
            wireBody.slice(53, 119),
            wireBody.slice(119),
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    });

    const result = await adapter.execute({
      endpoint: "chat/completions",
      body: { model: "test/model", stream: true },
      apiKey: "secret",
    });

    expect(await result.response.text()).toBe(wireBody);
    const completion = await result.completion;
    expect(completion.state).toBe("complete");
    if (completion.state !== "complete") throw new Error("Expected usage");
    expect(completion.providerRequestId).toBe("gen-1");
    expect(completion.usage.costUsd.toString()).toBe("0.000400000000");
    expect(completion.responseBody).toBe(wireBody);
  });

  test("normalizes non-streaming responses without modifying the body", async () => {
    const wireBody = JSON.stringify({
      id: "gen-json",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 1,
        cost: 0.002,
      },
    });
    const adapter = new OpenRouterAdapter({
      fetch: (async () =>
        new Response(wireBody, {
          headers: { "content-type": "application/json" },
        })),
    });

    const result = await adapter.execute({
      endpoint: "chat/completions",
      body: { model: "test/model" },
      apiKey: "secret",
    });

    expect(await result.response.text()).toBe(wireBody);
    expect((await result.completion).state).toBe("complete");
  });

  test("marks missing usage as uncertain for reconciliation", async () => {
    const adapter = new OpenRouterAdapter({
      fetch: (async () =>
        new Response('data: {"id":"gen-unknown","choices":[]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        })),
    });
    const result = await adapter.execute({
      endpoint: "chat/completions",
      body: { model: "test/model", stream: true },
      apiKey: "secret",
    });

    await result.response.text();
    const completion = await result.completion;
    expect(completion.state).toBe("uncertain");
    expect(completion.providerRequestId).toBe("gen-unknown");
  });

  test("cancels upstream and preserves the partial body", async () => {
    let cancelled = false;
    const adapter = new OpenRouterAdapter({
      fetch: (async () =>
        new Response(
          chunkedBody(
            [
              'data: {"id":"gen-cancelled","choices":[]}\n\n',
              "data: never consumed\n\n",
            ],
            () => {
              cancelled = true;
            },
          ),
          { headers: { "content-type": "text/event-stream" } },
        )),
    });
    const result = await adapter.execute({
      endpoint: "chat/completions",
      body: { model: "test/model", stream: true },
      apiKey: "secret",
    });
    const reader = result.response.body?.getReader();
    await reader?.read();
    await reader?.cancel("client disconnected");

    const completion = await result.completion;
    expect(cancelled).toBeTrue();
    expect(completion.state).toBe("cancelled");
    if (completion.state !== "cancelled") throw new Error("Expected cancel");
    expect(completion.reason).toBe("client disconnected");
    expect(completion.providerRequestId).toBe("gen-cancelled");
    expect(completion.responseBody).toContain("gen-cancelled");
  });

  test("settles cancellation even when the upstream cancel rejects", async () => {
    const adapter = new OpenRouterAdapter({
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(encoder.encode('data: {"id":"gen-gone"}\n\n'));
            },
            cancel() {
              throw new Error("socket already closed");
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )),
    });
    const result = await adapter.execute({
      endpoint: "chat/completions",
      body: { model: "test/model", stream: true },
      apiKey: "secret",
    });
    const reader = result.response.body?.getReader();
    await reader?.read();
    await reader?.cancel("client disconnected");

    const completion = await result.completion;
    expect(completion.state).toBe("cancelled");
    expect(completion.providerRequestId).toBe("gen-gone");
  });
});
