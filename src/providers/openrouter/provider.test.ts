import { describe, expect, test } from "bun:test";

import { fetchOpenRouterGeneration } from "./generation";
import { OPENROUTER, openRouterProvider } from "./provider";

const notFound = () => new Response("", { status: 404 });

const generationResponse = (cost: number, id = "gen-1") =>
  Response.json({
    data: { id, model: "test/model", total_cost: cost, native_tokens_prompt: 5, native_tokens_completion: 7 },
  });

const openRouter = (respond: (url: string) => Response) => ({
  apiKey: "key",
  baseUrl: "https://upstream.test/api/",
  fetch: (async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
    return respond(String(input));
  }) as typeof fetch,
});

describe("fetchOpenRouterGeneration", () => {
  test("parses the generation record", async () => {
    const lookup = await fetchOpenRouterGeneration(
      "gen-1",
      openRouter((url) => {
        expect(url).toBe("https://upstream.test/api/v1/generation?id=gen-1");
        return generationResponse(0.00042);
      }),
    );
    if (lookup.state !== "found") throw new Error("expected found");
    expect(lookup.generation.totalCostUsd.toString()).toBe("0.000420000000");
    expect(lookup.generation.promptTokens).toBe(5);
    expect(lookup.generation.completionTokens).toBe(7);
    expect(lookup.generation.model).toBe("test/model");
  });

  test("treats 404 as not yet available and other errors as failures", async () => {
    expect(await fetchOpenRouterGeneration("x", openRouter(notFound))).toEqual({ state: "not_found" });
    await expect(
      fetchOpenRouterGeneration("x", openRouter(() => new Response("", { status: 500 }))),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("openRouterProvider", () => {
  test("reserves under the openrouter key", () => {
    expect(openRouterProvider(openRouter(notFound)).key).toBe(OPENROUTER);
    expect(OPENROUTER).toBe("openrouter");
  });

  test("charges a found generation with its model and tokens", async () => {
    const charge = await openRouterProvider(openRouter(() => generationResponse(0.002, "gen-9"))).reconcile!("gen-9");
    if (charge.state !== "charged") throw new Error("expected charged");
    expect(charge.costUsd.toString()).toBe("0.002000000000");
    expect(charge).toMatchObject({ model: "test/model", inputTokens: 5, outputTokens: 7 });
  });

  test("maps 404 to not_found and throws on other failures", async () => {
    expect(await openRouterProvider(openRouter(notFound)).reconcile!("x")).toEqual({ state: "not_found" });
    await expect(
      openRouterProvider(openRouter(() => new Response("", { status: 500 }))).reconcile!("x"),
    ).rejects.toThrow("HTTP 500");
  });
});
