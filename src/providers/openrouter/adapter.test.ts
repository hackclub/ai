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

  test("truncates captured SSE bytes past the cap while keeping usage and client bytes", async () => {
    const wireBody =
      ": " + "x".repeat(98) + "\n\n" +
      'data: {"id":"gen-big","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.001}}\n\n' +
      "data: [DONE]\n\n";
    const adapter = new OpenRouterAdapter({
      maxCapturedBytes: 64,
      fetch: (async () =>
        new Response(chunkedBody([wireBody]), {
          headers: { "content-type": "text/event-stream" },
        })),
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
    expect(completion.bodyCapture).toBe("truncated");
    expect(completion.responseBody.length).toBeLessThanOrEqual(64);
  });

  test("truncation is sticky: a later chunk that would fit is not appended after an overflow", async () => {
    const wireBody =
      ": " + "x".repeat(98) + "\n\n" +
      'data: {"id":"gen-big","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.001}}\n\n' +
      "data: [DONE]\n\n";
    // part1 fits under the cap; part2 alone would overflow it (setting
    // truncated); part3 alone would fit under the cap, but must still be
    // skipped because truncation is sticky, not re-evaluated per chunk.
    const part1 = wireBody.slice(0, 40);
    const part2 = wireBody.slice(40, 90);
    const part3 = wireBody.slice(90);
    const adapter = new OpenRouterAdapter({
      maxCapturedBytes: 64,
      fetch: (async () =>
        new Response(chunkedBody([part1, part2, part3]), {
          headers: { "content-type": "text/event-stream" },
        })),
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
    expect(completion.bodyCapture).toBe("truncated");
    // Exact equality proves no hole: the stored body is precisely the
    // chunk(s) captured before the overflow, nothing from part2 or part3.
    expect(completion.responseBody).toBe(part1);
    expect(completion.responseBody.length).toBe(part1.length);
  });

  test("does not truncate a non-streaming JSON body over the cap", async () => {
    const wireBody = JSON.stringify({
      id: "gen-json-big",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 1,
        cost: 0.002,
      },
    });
    const adapter = new OpenRouterAdapter({
      maxCapturedBytes: 16,
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
    const completion = await result.completion;
    expect(completion.state).toBe("complete");
    if (completion.state !== "complete") throw new Error("Expected usage");
    expect(completion.bodyCapture).toBe("complete");
    expect(completion.responseBody).toBe(wireBody);
  });
});
