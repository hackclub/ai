import { describe, expect, test } from "bun:test";

import { JEV_MODEL, jevTokens } from "./provider";

describe("typesafe provider", () => {
  test("jevTokens reads usage and defaults missing output tokens to zero", () => {
    expect(jevTokens({ usage: { input_tokens: 1_000, output_tokens: 20 } })).toEqual({
      inputTokens: 1_000,
      outputTokens: 20,
    });
    expect(jevTokens({ usage: { input_tokens: 5 } })).toEqual({ inputTokens: 5, outputTokens: 0 });
  });

  test("jevTokens is null without usable input tokens", () => {
    expect(jevTokens({})).toBeNull();
    expect(jevTokens({ usage: null })).toBeNull();
    expect(jevTokens({ usage: { input_tokens: -1 } })).toBeNull();
    expect(jevTokens({ usage: { input_tokens: 1.5 } })).toBeNull();
  });

  test("JEV_MODEL accepts only the Jev family", () => {
    expect(JEV_MODEL.test("jev-latest")).toBe(true);
    expect(JEV_MODEL.test("jev")).toBe(true);
    expect(JEV_MODEL.test("gpt-4")).toBe(false);
  });
});
