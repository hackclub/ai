import { describe, expect, test } from "bun:test";

import { Usd } from "../billing/money";
import { executeSseProvider } from "./sse-provider";

const cost = (event: unknown) => {
  const total = (event as { cost?: unknown })?.cost;
  return typeof total === "number" ? Usd.fromNumber(total) : null;
};

describe("executeSseProvider", () => {
  test("gives up draining after the timeout and leaves the outcome uncertain", async () => {
    let upstreamCancelled = false;
    const result = await executeSseProvider({
      url: "http://provider.test/answer",
      init: { method: "POST", body: "{}" },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"text":"a"}\n\n'));
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      extractCost: cost,
      drainTimeoutMs: 5,
    });
    const reader = result.response.body!.getReader();
    await reader.read();
    await reader.cancel();

    const completion = await result.completion;
    expect(upstreamCancelled).toBeTrue();
    if (completion.state !== "uncertain") throw new Error("Expected uncertain");
    expect(completion.reason).toContain("drain timeout");
  });

  const events = (parts: Array<string | (() => Promise<string>)>) =>
    new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const part = parts.shift();
          if (part === undefined) return controller.close();
          controller.enqueue(new TextEncoder().encode(typeof part === "string" ? part : await part()));
        },
      }),
      { headers: { "content-type": "text/event-stream", "set-cookie": "s=1" } },
    );
  const run = (response: Response) =>
    executeSseProvider({
      url: "http://provider.test/answer",
      init: { method: "POST", body: "{}" },
      fetch: async () => response,
      extractCost: cost,
      extractProviderRequestId: (event) => (event as { id?: string })?.id ?? null,
      drainTimeoutMs: 1_000,
    });

  test("forwards the stream and bills the cost from its event", async () => {
    const wire = 'data: {"id":"a1","text":"hi"}\n\ndata: {"cost":0.005}\n\n';
    const result = await run(events([wire.slice(0, 10), wire.slice(10)]));
    expect(result.response.headers.get("set-cookie")).toBeNull();
    expect(await result.response.text()).toBe(wire);
    expect(await result.completion).toMatchObject({
      state: "complete",
      providerRequestId: "a1",
      responseBody: wire,
      bodyCapture: "complete",
    });
  });

  test("keeps draining after the client leaves and bills the cost it then sees", async () => {
    const later = async () => {
      await Bun.sleep(5);
      return 'data: {"cost":0.01}\n\n';
    };
    const result = await run(events(['data: {"text":"a"}\n\n', later]));
    const reader = result.response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const completion = await result.completion;
    if (completion.state !== "complete") throw new Error("Expected complete");
    expect(completion.usage.costUsd.toString()).toBe("0.010000000000");
  });

  test("a stream that ends without a cost is uncertain, with the whole body captured", async () => {
    const result = await run(events(['data: {"text":"a"}\n\n']));
    await result.response.text();
    expect(await result.completion).toMatchObject({
      state: "uncertain",
      reason: "Provider stream ended without reporting a cost",
      bodyCapture: "complete",
    });
  });

  test("meters a non-stream reply as JSON", async () => {
    const result = await executeSseProvider({
      url: "http://provider.test/answer",
      init: { method: "POST", body: "{}" },
      fetch: async () => Response.json({ cost: 0.01 }),
      extractCost: cost,
    });
    const completion = await result.completion;
    expect(completion.state).toBe("complete");
  });
});
