import { expect, test } from "bun:test";

import {
  estimateLanguageReservation,
  type LanguageReservationInput,
} from "./estimate-language-reservation";

const estimate = (over: Partial<LanguageReservationInput>) =>
  estimateLanguageReservation({
    serializedBillableInput: "",
    inputTokenPriceUsd: "0",
    outputTokenPriceUsd: "0",
    modelMaxOutputTokens: 0,
    ...over,
  });

test.each([
  [
    "reserves rounded-up input, bounded output, and fixed costs",
    {
      serializedBillableInput: "123456789",
      inputTokenPriceUsd: "0.001",
      outputTokenPriceUsd: "0.002",
      requestedMaxOutputTokens: 10,
      modelMaxOutputTokens: 1_000,
      fixedCostUsd: "0.05",
    },
    [3, 10, "0.073000000000"],
  ],
  [
    "reserves the model maximum when the caller omits an output bound",
    { outputTokenPriceUsd: "0.000000000001", modelMaxOutputTokens: 4_096 },
    [0, 4_096, "0.000000004096"],
  ],
  [
    "reserves the output bound once per requested completion",
    {
      serializedBillableInput: "12345678",
      inputTokenPriceUsd: "0.001",
      outputTokenPriceUsd: "0.002",
      requestedMaxOutputTokens: 10,
      modelMaxOutputTokens: 1_000,
      completions: 3,
    },
    [2, 30, "0.062000000000"],
  ],
  [
    "never reserves beyond the model output limit",
    { outputTokenPriceUsd: "1", requestedMaxOutputTokens: 10_000, modelMaxOutputTokens: 2_000 },
    [0, 2_000, "2000.000000000000"],
  ],
] as const)("%s", (_name, input, [inputTokens, outputTokens, amount]) => {
  const result = estimate(input);
  expect(result.estimatedInputTokens).toBe(inputTokens);
  expect(result.reservedOutputTokens).toBe(outputTokens);
  expect(result.amountUsd.toString()).toBe(amount);
});

test.each([
  [{ completions: 0 }, "completions"],
  [{ inputTokenPriceUsd: "1e-7" }, "Invalid USD value"],
  [{ inputTokenPriceUsd: "-0.01" }, "Provider prices must not be negative"],
  [{ requestedMaxOutputTokens: -1 }, "requestedMaxOutputTokens"],
] as const)("rejects %p", (input, message) => {
  expect(() => estimate(input)).toThrow(message);
});
