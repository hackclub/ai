import { describe, expect, test } from "bun:test";

import { Elysia } from "elysia";

import { createApp } from "./app";
import type { ProxyDependencies } from "./gateway/proxy";
import { RateLimiter } from "./gateway/rate-limit";

// Routes exercised here never reach the proxy dependencies.
const app = createApp({ proxy: {} as ProxyDependencies });
const call = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://gateway.test${path}`, init));

describe("createApp", () => {
  test("answers unknown routes with the gateway's error shape", async () => {
    const response = await call("/nope", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  test("keeps HttpError headers such as Retry-After", async () => {
    const limiter = new RateLimiter({ limit: 0, windowMs: 60_000 });
    const limited = createApp({
      proxy: {} as ProxyDependencies,
      routes: [new Elysia().get("/limited", () => limiter.consume("caller"))],
    });
    const response = await limited.handle(new Request("http://gateway.test/limited"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("ratelimit-policy")).toBe("0;w=60");
    expect(((await response.json()) as { error: string }).error).toContain("Rate limit exceeded");
  });
});
