import { describe, expect, test } from "bun:test";

import { exaCost } from "./provider";

describe("exa provider", () => {
  test("exaCost rejects a negative, missing or non-numeric cost", () => {
    expect(exaCost({ costDollars: { total: -1 } })).toBeNull();
    expect(exaCost({ costDollars: {} })).toBeNull();
    expect(exaCost({ costDollars: { total: "0.1" } })).toBeNull();
    expect(exaCost({})).toBeNull();
    expect(exaCost(null)).toBeNull();
  });
});
