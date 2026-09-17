import { describe, expect, test } from "bun:test";

import { openRouterRequestId, openRouterUsage } from "./usage";

describe("OpenRouter usage normalization", () => {
  test("normalizes chat completion usage and total charged cost", () => {
    const usage = openRouterUsage({
      id: "gen-chat",
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        cost: 1e-7,
        cost_details: { upstream_inference_cost: 0.5 },
      },
    });

    expect(openRouterRequestId({ id: "gen-chat" })).toBe("gen-chat");
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(12);
    expect(usage?.outputTokens).toBe(4);
    expect(usage?.costUsd.toString()).toBe("0.000000100000");
  });

  test("normalizes nested Responses API usage", () => {
    const value = {
      response: {
        id: "gen-response",
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cost: 0.002,
        },
      },
    };

    expect(openRouterRequestId(value)).toBe("gen-response");
    expect(openRouterUsage(value)?.totalTokens).toBe(25);
  });

  test("requires authoritative cost even when token counts exist", () => {
    expect(
      openRouterUsage({
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    ).toBeNull();
  });
});
