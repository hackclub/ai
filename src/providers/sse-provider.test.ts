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
