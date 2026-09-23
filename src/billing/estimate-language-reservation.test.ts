import { describe, expect, test } from "bun:test";

import { estimateLanguageReservation } from "./estimate-language-reservation";

describe("estimateLanguageReservation", () => {
  test("reserves input, bounded output, and fixed provider costs", () => {
    const estimate = estimateLanguageReservation({
      serializedBillableInput: "123456789",
      inputTokenPriceUsd: "0.001",
      outputTokenPriceUsd: "0.002",
      requestedMaxOutputTokens: 10,
      modelMaxOutputTokens: 1_000,
      fixedCostUsd: "0.05",
    });

    expect(estimate.estimatedInputTokens).toBe(3);
    expect(estimate.reservedOutputTokens).toBe(10);
    expect(estimate.amountUsd.toString()).toBe("0.073000000000");
  });

  test("reserves the model maximum when the caller omits an output bound", () => {
    const estimate = estimateLanguageReservation({
      serializedBillableInput: "",
      inputTokenPriceUsd: "0",
      outputTokenPriceUsd: "0.000000000001",
      modelMaxOutputTokens: 4_096,
    });

    expect(estimate.reservedOutputTokens).toBe(4_096);
    expect(estimate.amountUsd.toString()).toBe("0.000000004096");
  });

  test("reserves the output bound once per requested completion", () => {
    const estimate = estimateLanguageReservation({
      serializedBillableInput: "12345678",
      inputTokenPriceUsd: "0.001",
      outputTokenPriceUsd: "0.002",
      requestedMaxOutputTokens: 10,
      modelMaxOutputTokens: 1_000,
      completions: 3,
    });

    expect(estimate.estimatedInputTokens).toBe(2);
    expect(estimate.reservedOutputTokens).toBe(30);
    expect(estimate.amountUsd.toString()).toBe("0.062000000000");
    expect(() =>
      estimateLanguageReservation({
        serializedBillableInput: "",
        inputTokenPriceUsd: "0",
        outputTokenPriceUsd: "0",
        modelMaxOutputTokens: 1,
        completions: 0,
      }),
    ).toThrow(RangeError);
  });

  test("never reserves beyond the model output limit", () => {
    const estimate = estimateLanguageReservation({
      serializedBillableInput: "",
      inputTokenPriceUsd: "0",
      outputTokenPriceUsd: "1",
      requestedMaxOutputTokens: 10_000,
      modelMaxOutputTokens: 2_000,
    });

    expect(estimate.reservedOutputTokens).toBe(2_000);
    expect(estimate.amountUsd.toString()).toBe("2000.000000000000");
  });

  test("rejects floating-point and invalid price inputs", () => {
    expect(() =>
      estimateLanguageReservation({
        serializedBillableInput: "",
        inputTokenPriceUsd: "1e-7",
        outputTokenPriceUsd: "0",
        modelMaxOutputTokens: 0,
      }),
    ).toThrow("Invalid USD value");
  });

  test("rejects negative provider prices and output limits", () => {
    expect(() =>
      estimateLanguageReservation({
        serializedBillableInput: "",
        inputTokenPriceUsd: "-0.01",
        outputTokenPriceUsd: "0",
        modelMaxOutputTokens: 0,
      }),
    ).toThrow("Provider prices must not be negative");

    expect(() =>
      estimateLanguageReservation({
        serializedBillableInput: "",
        inputTokenPriceUsd: "0",
        outputTokenPriceUsd: "0",
        requestedMaxOutputTokens: -1,
        modelMaxOutputTokens: 0,
      }),
    ).toThrow("requestedMaxOutputTokens");
  });
});
