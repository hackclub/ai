import { describe, expect, test } from "bun:test";

import { createReplicateCatalog } from "./catalog";

const modelResponse = (id: string) => {
  const [owner, name] = id.split("/");
  return Response.json({ url: `https://replicate.com/${id}`, owner, name, description: "", visibility: "public" });
};

const catalogWith = () => {
  let calls = 0;
  const catalog = createReplicateCatalog({
    apiKey: "k",
    baseUrl: "https://api.example.test",
    ttlMs: 60_000,
    pricing: { get: async () => null },
    fetch: (async (url) => {
      calls += 1;
      const id = String(url).replace("https://api.example.test/v1/models/", "");
      return modelResponse(id);
    }) as typeof fetch,
  });
  return { catalog, calls: () => calls };
};

describe("createReplicateCatalog", () => {
  test("fetches each configured model once and serves the cache within the TTL", async () => {
    const { catalog, calls } = catalogWith();
    const first = await catalog.categories();
    const afterFirst = calls();
    expect(afterFirst).toBeGreaterThan(0);
    const second = await catalog.categories();
    expect(second).toBe(first);
    expect(calls()).toBe(afterFirst);
  });

  test("shares one in-flight refresh between concurrent callers", async () => {
    const { catalog, calls } = catalogWith();
    const [a, b] = await Promise.all([catalog.categories(), catalog.categories()]);
    expect(a).toBe(b);
    const once = calls();
    await catalog.categories();
    expect(calls()).toBe(once);
  });
});
