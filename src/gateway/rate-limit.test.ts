import { describe, expect, test } from "bun:test";

import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  test("counts per key inside a window and resets after it", () => {
    let clock = 1_000;
    const limiter = new RateLimiter({ limit: 2, windowMs: 100, now: () => clock });
    expect(limiter.consume("a")).toBe(1);
    expect(limiter.consume("a")).toBe(0);
    expect(limiter.consume("b")).toBe(1);
    expect(() => limiter.consume("a")).toThrow("Rate limit exceeded");
    clock += 100;
    expect(limiter.consume("a")).toBe(1);
  });
});
