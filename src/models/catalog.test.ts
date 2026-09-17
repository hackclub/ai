import { describe, expect, test } from "bun:test";

import { ModelCatalog, modelPricing } from "./catalog";

const listing = (ids: string[]) =>
  Response.json({
    data: ids.map((id) => ({
      id,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      top_provider: { max_completion_tokens: 4096 },
    })),
  });

const catalogWith = (
  responses: Array<() => Response>,
  allowed: string[] = [],
) => {
  let calls = 0;
  const clock = { now: 0 };
  const catalog = new ModelCatalog({
    now: () => clock.now,
    baseUrl: "https://example.test/api/",
    apiKey: "k",
    allowedLanguageModels: allowed,
    allowedEmbeddingModels: [],
    ttlMs: 60_000,
    fetch: (async (url, init) => {
      calls += 1;
      expect(String(url)).toBe("https://example.test/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
      const next = responses.shift();
      if (!next) throw new Error("No response scripted");
      return next();
    }) as typeof fetch,
  });
  return { catalog, calls: () => calls, clock };
};

describe("ModelCatalog", () => {
  test("applies the allowlist and caches the listing", async () => {
    const { catalog, calls } = catalogWith(
      [() => listing(["a/one", "b/two"])],
      ["b/two"],
    );
    expect((await catalog.list("language")).map((m) => m.id)).toEqual([
      "b/two",
    ]);
    expect(await catalog.find("language", "a/one")).toBeNull();
    expect((await catalog.find("language", "b/two"))?.id).toBe("b/two");
    expect(calls()).toBe(1);
  });

  test("shares one in-flight refresh between concurrent callers", async () => {
    const { catalog, calls } = catalogWith([() => listing(["a/one"])]);
    await Promise.all([catalog.list("language"), catalog.list("language")]);
    expect(calls()).toBe(1);
  });

  test("serves the previous listing when a refresh fails", async () => {
    const { catalog, clock } = catalogWith([
      () => listing(["a/one"]),
      () => new Response("down", { status: 503 }),
    ]);
    const first = await catalog.list("language");
    clock.now += 60_000;
    expect(await catalog.list("language")).toBe(first);
  });

  test("fails when there is no listing to fall back to", async () => {
    const { catalog } = catalogWith([
      () => new Response("down", { status: 503 }),
    ]);
    await expect(catalog.list("language")).rejects.toThrow("HTTP 503");
  });
});

describe("modelPricing", () => {
  test("parses fixed prices and the provider maximum", () => {
    const pricing = modelPricing({
      id: "m",
      pricing: { prompt: "0.000001", completion: "0.000002", request: "0" },
      top_provider: { max_completion_tokens: 1024 },
    });
    expect(pricing?.promptUsd.toString()).toBe("0.000001000000");
    expect(pricing?.completionUsd.toString()).toBe("0.000002000000");
    expect(pricing?.maxCompletionTokens).toBe(1024);
  });

  test("treats missing components as free and absent limits as null", () => {
    const pricing = modelPricing({ id: "m", pricing: { prompt: "0" } });
    expect(pricing?.completionUsd.toAtoms()).toBe(0n);
    expect(pricing?.maxCompletionTokens).toBeNull();
  });

  test("rejects dynamic or malformed prices", () => {
    expect(modelPricing({ id: "m", pricing: { prompt: "-1" } })).toBeNull();
    expect(modelPricing({ id: "m", pricing: { prompt: "1e-7" } })).toBeNull();
  });
});
