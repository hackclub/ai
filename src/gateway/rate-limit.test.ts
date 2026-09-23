import { describe, expect, test } from "bun:test";

import { HttpError } from "./http-error";
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

  test("sends Retry-After and RateLimit headers on 429", () => {
    let clock = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
    limiter.consume("a");
    clock = 15_500;
    let error: unknown;
    try {
      limiter.consume("a");
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof HttpError)) throw new Error("Expected HttpError");
    const response = error.toResponse();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(response.headers.get("ratelimit-reset")).toBe("45");
    expect(response.headers.get("ratelimit-policy")).toBe("1;w=60");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-should-retry")).toBeNull();

    clock = 0;
    const slow = new RateLimiter({ limit: 0, windowMs: 30 * 60_000, now: () => clock });
    try {
      slow.consume("a");
    } catch (caught) {
      if (!(caught instanceof HttpError)) throw caught;
      expect(caught.toResponse().headers.get("x-should-retry")).toBe("false");
    }
  });
});
