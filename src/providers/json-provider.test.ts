import { describe, expect, test } from "bun:test";

import { Usd } from "../billing/money";
import { executeJsonProvider } from "./json-provider";

const run = (response: Response, redact?: (body: unknown, raw: string) => string) =>
  executeJsonProvider({
    url: "https://provider.test/v1/thing",
    init: { method: "POST", body: '{"q":1}' },
    fetch: async () => response,
    extractCost: (body) => {
      const cost = (body as { cost?: number }).cost;
      return typeof cost === "number" ? Usd.fromNumber(cost) : null;
    },
    extractProviderRequestId: (body) => (body as { id?: string }).id ?? null,
    redactResponseBody: redact,
  });

describe("executeJsonProvider", () => {
  test("passes the body through and completes with the reported cost", async () => {
    const wire = '{"id":"r1","cost":0.002,"data":"x"}';
    const result = await run(
      new Response(wire, {
        status: 201,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      }),
    );
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("content-encoding")).toBeNull();
    expect(await result.response.text()).toBe(wire);
    expect(result.requestBody).toBe('{"q":1}');
    const completion = await result.completion;
    expect(completion.state).toBe("complete");
    if (completion.state !== "complete") throw new Error("expected complete");
    expect(completion.usage.costUsd.toString()).toBe("0.002000000000");
    expect(completion.providerRequestId).toBe("r1");
    expect(completion.responseBody).toBe(wire);
  });

  test("redacts the analytics body only", async () => {
    const wire = '{"cost":0.1,"secret":"text"}';
    const result = await run(new Response(wire), () => '{"redacted":true}');
    expect(await result.response.text()).toBe(wire);
    expect((await result.completion).responseBody).toBe('{"redacted":true}');
  });

  test.each([
    [new Response('{"error":"bad"}', { status: 400 }), "HTTP 400"],
    [new Response("not json"), "non-JSON"],
    [new Response('{"data":1}'), "did not report a cost"],
  ])("marks %o uncertain", async (response, reason) => {
    const completion = await (await run(response)).completion;
    expect(completion.state).toBe("uncertain");
    if (completion.state !== "uncertain") throw new Error("expected uncertain");
    expect(completion.reason).toContain(reason);
  });
});
