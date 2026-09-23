import { HttpError } from "./http-error";

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  now?: () => number;
};

/**
 * Fixed-window counter keyed by caller. Process-local: with more than one
 * replica each replica applies the limit independently, as the previous
 * gateway did. Swap the store for Redis or PostgreSQL if that changes.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Returns remaining requests in the window, or throws 429. */
  consume(key: string): number {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.options.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
      if (this.windows.size > 50_000) this.evict(now);
    }
    if (window.count >= this.options.limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((window.start + this.options.windowMs - now) / 1_000),
      );
      // Retry-After is what SDK backoff reads; the RateLimit-* set (IETF
      // draft-6) matches what the previous gateway's limiter sent. OpenAI's
      // Node SDK ignores a Retry-After over 60s and retries anyway, so waits
      // that long also say not to retry.
      throw new HttpError(429, `Rate limit exceeded. Retry in ${retryAfter}s.`, {
        ...(retryAfter > 60 ? { "x-should-retry": "false" } : {}),
        "retry-after": String(retryAfter),
        "ratelimit-limit": String(this.options.limit),
        "ratelimit-remaining": "0",
        "ratelimit-reset": String(retryAfter),
        "ratelimit-policy": `${this.options.limit};w=${Math.ceil(this.options.windowMs / 1_000)}`,
      });
    }
    window.count += 1;
    return this.options.limit - window.count;
  }

  private evict(now: number) {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.options.windowMs) this.windows.delete(key);
    }
  }
}
