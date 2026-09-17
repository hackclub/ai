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
      const retryAfter = Math.ceil(
        (window.start + this.options.windowMs - now) / 1_000,
      );
      throw new HttpError(429, `Rate limit exceeded. Retry in ${retryAfter}s.`);
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
