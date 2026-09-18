import { describe, expect, test } from "bun:test";

import { withKeepAlive } from "./proxy";

const encoder = new TextEncoder();

describe("withKeepAlive", () => {
  test("pads with whitespace until the first upstream byte", async () => {
    let release: () => void = () => {};
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        controller.enqueue(encoder.encode('{"ok":true}'));
        controller.close();
      },
    });
    const wrapped = withKeepAlive(
      new Response(upstream, { headers: { "content-type": "application/json" } }),
      5,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const text = await wrapped.text();
    expect(text.startsWith(" ")).toBeTrue();
    expect(JSON.parse(text)).toEqual({ ok: true });
  });

  test("forwards client cancellation to the upstream body", async () => {
    let cancelledWith: unknown = null;
    const upstream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const wrapped = withKeepAlive(
      new Response(upstream, { headers: { "content-type": "application/json" } }),
      5,
    );
    const reader = wrapped.body?.getReader();
    await reader?.cancel("client disconnected");
    expect(cancelledWith).toBe("client disconnected");
  });

  test("leaves event streams untouched", () => {
    const response = new Response("data: x\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    expect(withKeepAlive(response, 5)).toBe(response);
  });
});
