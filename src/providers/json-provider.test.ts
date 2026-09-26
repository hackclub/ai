import { describe, expect, test } from "bun:test";

import { Usd } from "../billing/money";
import { executeJsonProvider } from "./json-provider";

const run = (response: Response) =>
  executeJsonProvider({
    url: "https://provider.test/v1/thing",
    init: { method: "POST", body: '{"q":1}' },
    fetch: async () => response,
    extractCost: (body) => {
      const cost = (body as { cost?: number }).cost;
      return typeof cost === "number" ? Usd.fromNumber(cost) : null;
    },
  });

describe("executeJsonProvider", () => {
  test.each([
    [new Response("not json"), "non-JSON"],
    [new Response('{"data":1}'), "did not report a cost"],
  ])("marks %o uncertain", async (response, reason) => {
    const completion = await (await run(response)).completion;
    if (completion.state !== "uncertain") throw new Error("expected uncertain");
    expect(completion.reason).toContain(reason);
  });
});
