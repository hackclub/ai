import { describe, expect, test } from "bun:test";

import { Usd } from "./money";

describe("Usd.parse", () => {
  test("parses a plain decimal and renders twelve decimal places", () => {
    expect(Usd.parse("0.01").toString()).toBe("0.010000000000");
  });

  test("parses a negative value", () => {
    const value = Usd.parse("-1.5");
    expect(value.isNegative()).toBeTrue();
    expect(value.toString()).toBe("-1.500000000000");
  });

  test("rejects more than twelve fractional digits", () => {
    expect(() => Usd.parse("1.0000000000001")).toThrow(RangeError);
  });

  test("rejects non-numeric strings", () => {
    expect(() => Usd.parse("abc")).toThrow(TypeError);
  });

  test("rejects exponent notation", () => {
    expect(() => Usd.parse("1e-7")).toThrow(TypeError);
  });

  test("rejects an empty string", () => {
    expect(() => Usd.parse("")).toThrow(TypeError);
  });
});

describe("Usd.fromNumber", () => {
  test("converts a small float via toFixed", () => {
    expect(Usd.fromNumber(0.00042).toString()).toBe("0.000420000000");
  });

  test("documents sub-atom rounding to zero", () => {
    expect(Usd.fromNumber(5e-13).toAtoms()).toBe(0n);
  });

  test("rejects NaN", () => {
    expect(() => Usd.fromNumber(NaN)).toThrow(TypeError);
  });

  test("rejects Infinity", () => {
    expect(() => Usd.fromNumber(Infinity)).toThrow(TypeError);
  });

  test("rejects values that toFixed renders in exponent form", () => {
    expect(() => Usd.fromNumber(1e21)).toThrow();
  });
});

describe("Usd arithmetic", () => {
  test("add sums two values", () => {
    expect(Usd.parse("0.01").add(Usd.parse("0.02")).toString()).toBe("0.030000000000");
  });

  test("multiply scales by a bigint multiplier", () => {
    expect(Usd.parse("0.01").multiply(3n).toString()).toBe("0.030000000000");
  });

  test("fromAtoms round-trips through toString", () => {
    expect(Usd.fromAtoms(5n).toString()).toBe("0.000000000005");
  });

  test("zero is not negative", () => {
    expect(Usd.zero.isNegative()).toBeFalse();
  });
});
