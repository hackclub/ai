import { describe, expect, test } from "bun:test";

import { modelPricing } from "./catalog";

describe("modelPricing", () => {
  test("defaults a missing request price to zero and absent limits to null", () => {
    const pricing = modelPricing({ id: "m", pricing: { prompt: "0", completion: "0" } });
    expect(pricing?.requestUsd.toAtoms()).toBe(0n);
    expect(pricing?.maxCompletionTokens).toBeNull();
  });

  test.each([
    ["no pricing", undefined],
    ["a missing completion price", { prompt: "0" }],
    ["a missing prompt price", { completion: "0" }],
    ["a dynamic (-1) price", { prompt: "-1", completion: "0" }],
    ["a malformed price", { prompt: "1e-7", completion: "0" }],
  ])("is unknown for %s", (_name, pricing) => {
    expect(modelPricing({ id: "m", pricing })).toBeNull();
  });
});
