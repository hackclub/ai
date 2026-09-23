import { describe, expect, test } from "bun:test";

import { ModelCatalog, modelPricing } from "./catalog";

const catalogWith = (response: () => Response) => {
  let calls = 0;
  const catalog = new ModelCatalog({
    baseUrl: "https://example.test/api/",
    apiKey: "k",
    fetch: (async (url: string, init?: RequestInit) => {
      calls += 1;
      expect(String(url)).toBe("https://example.test/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
      return response();
    }) as unknown as typeof fetch,
  });
  return { catalog, calls: () => calls };
};

describe("ModelCatalog", () => {
  test("lists every model and caches the listing", async () => {
    const { catalog, calls } = catalogWith(() =>
      Response.json({ data: [{ id: "a/one" }, { id: "b/two" }, { name: "no id" }] }),
    );
    expect((await catalog.list("language")).map((m) => m.id)).toEqual(["a/one", "b/two"]);
    expect(await catalog.find("language", "c/three")).toBeNull();
    expect((await catalog.find("language", "b/two"))?.id).toBe("b/two");
    expect(calls()).toBe(1);
  });

  test("fails when there is no listing to fall back to", async () => {
    const { catalog } = catalogWith(() => new Response("down", { status: 503 }));
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

  test("defaults a missing request price to zero and absent limits to null", () => {
    const pricing = modelPricing({ id: "m", pricing: { prompt: "0", completion: "0" } });
    expect(pricing?.requestUsd.toAtoms()).toBe(0n);
    expect(pricing?.maxCompletionTokens).toBeNull();
  });

  test.each([
    ["no pricing", undefined],
    ["a missing completion price", { prompt: "0" }],
    ["a missing prompt price", { completion: "0" }],
    ["a dynamic (-1) price", { prompt: "-1", completion: "0" }],
    ["a malformed price", { prompt: "1e-7", completion: "0" }],
  ])("is unknown for %s", (_name, pricing) => {
    expect(modelPricing({ id: "m", pricing })).toBeNull();
  });
});
