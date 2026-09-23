import { describe, expect, test } from "bun:test";

import { Usd } from "./money";

describe("Usd.parse", () => {
  test.each([
    ["0.01", "0.010000000000"],
    ["-1.5", "-1.500000000000"],
  ])("parses %p and renders twelve decimal places", (input, rendered) => {
    expect(Usd.parse(input).toString()).toBe(rendered);
  });

  test.each([
    ["1.0000000000001", RangeError],
    ["abc", TypeError],
    ["1e-7", TypeError],
    ["", TypeError],
  ])("rejects %p", (input, error) => {
    expect(() => Usd.parse(input)).toThrow(error);
  });
});

describe("Usd.fromNumber", () => {
  test("converts a small float exactly", () => {
    expect(Usd.fromNumber(0.00042).toString()).toBe("0.000420000000");
  });

  test("rounds sub-atom values to zero", () => {
    expect(Usd.fromNumber(5e-13).toAtoms()).toBe(0n);
  });

  test.each([NaN, Infinity, 1e21])("rejects %p", (value) => {
    expect(() => Usd.fromNumber(value)).toThrow();
  });
});
