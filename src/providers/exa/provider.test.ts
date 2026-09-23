import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { EXA, exaCost, exaProvider, exaRequestId } from "./provider";

describe("exa provider", () => {
  test("reserves under the exa key and declares no lookup", () => {
    expect(EXA).toBe("exa");
    expect(exaProvider).toEqual({ key: "exa", reconcile: null });
  });

  test("exaCost reads costDollars.total", () => {
    expect(exaCost({ costDollars: { total: 0.005 } })?.equals(Usd.parse("0.005"))).toBe(true);
    expect(exaCost({ costDollars: { total: 0 } })?.equals(Usd.zero)).toBe(true);
  });

  test("exaCost rejects a negative, missing or non-numeric cost", () => {
    expect(exaCost({ costDollars: { total: -1 } })).toBeNull();
    expect(exaCost({ costDollars: {} })).toBeNull();
    expect(exaCost({ costDollars: { total: "0.1" } })).toBeNull();
    expect(exaCost({})).toBeNull();
    expect(exaCost(null)).toBeNull();
  });

  test("exaRequestId reads a string requestId", () => {
    expect(exaRequestId({ requestId: "req-1" })).toBe("req-1");
    expect(exaRequestId({ requestId: 1 })).toBeNull();
    expect(exaRequestId("req-1")).toBeNull();
  });
});
