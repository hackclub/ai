import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import type { ProxyDependencies } from "./gateway/proxy";

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
});
