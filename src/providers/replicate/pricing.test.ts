import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import {
  createReplicatePricingSource,
  describePricing,
  estimatePredictionCost,
  parseReplicatePricing,
  predictionCost,
  scaleUsd,
} from "./pricing";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/${name}.html`, import.meta.url)).text();

describe("parseReplicatePricing", () => {
  test("reads the hardware per-second rate for a community model", async () => {
    const pricing = parseReplicatePricing(await fixture("lucataco_remove-bg"));
    expect(pricing?.kind).toBe("hardware");
    if (pricing?.kind !== "hardware") return;
    expect(pricing.hardware).toBe("T4");
    expect(pricing.perSecondUsd.toString()).toBe(Usd.parse("0.000225").toString());
    expect(pricing.medianRunUsd?.toString()).toBe(Usd.parse("0.00033").toString());
  });

  test("reads per-thousand unit prices for an official model", async () => {
    const pricing = parseReplicatePricing(await fixture("minimax_speech-02-turbo"));
    expect(pricing?.kind).toBe("per-unit");
    if (pricing?.kind !== "per-unit") return;
    expect(pricing.tiers).toHaveLength(1);
    const [price] = pricing.tiers[0]!.prices;
    expect(price?.metric).toBe("token_input_count");
    // $0.06 per thousand input tokens.
    expect(price?.unitUsd.toString()).toBe(Usd.parse("0.00006").toString());
  });

  test("reads whole-dollar per-thousand prices", async () => {
    const pricing = parseReplicatePricing(await fixture("recraft-ai_recraft-crisp-upscale"));
    if (pricing?.kind !== "per-unit") throw new Error("expected per-unit pricing");
    // $6 per thousand output images.
    expect(pricing.tiers[0]!.prices[0]!.unitUsd.toString()).toBe(Usd.parse("0.006").toString());
  });

  test("reads tiered pricing with criteria", async () => {
    const pricing = parseReplicatePricing(await fixture("retro-diffusion_rd-plus"));
    if (pricing?.kind !== "per-unit") throw new Error("expected per-unit pricing");
    expect(pricing.tiers.length).toBeGreaterThan(5);
    const first = pricing.tiers[0]!;
    expect(first.criteria).toEqual([
      { type: "equals", title: "model variant", value: "rd_plus_classic" },
      { type: "range", title: "output image pixel", min: null, max: 1024 },
    ]);
  });

  test("returns null when the page carries no pricing", () => {
    expect(parseReplicatePricing("<html><body>nothing</body></html>")).toBeNull();
    expect(
      parseReplicatePricing(
        '<script id="react-component-props-x" type="application/json">{"billingConfig": null}</script>',
      ),
    ).toBeNull();
  });
});

describe("predictionCost", () => {
  test("bills hardware models on predict_time", async () => {
    const pricing = parseReplicatePricing(await fixture("lucataco_remove-bg"))!;
    const cost = predictionCost(pricing, { predict_time: 2, total_time: 3 });
    expect(cost.toString()).toBe(Usd.parse("0.00045").toString());
    expect(predictionCost(pricing, {}).toString()).toBe(Usd.zero.toString());
  });

  test("bills per-unit models on the matching metric", async () => {
    const pricing = parseReplicatePricing(await fixture("minimax_speech-02-turbo"))!;
    const cost = predictionCost(pricing, { token_input_count: 500, predict_time: 9 });
    expect(cost.toString()).toBe(Usd.parse("0.03").toString());
  });

  test("bills fractional units such as seconds of audio", async () => {
    const pricing = parseReplicatePricing(await fixture("google_lyria-2"))!;
    // $2 per thousand seconds; 32.5 seconds.
    const cost = predictionCost(pricing, { audio_output_duration_seconds: 32.5 });
    expect(cost.toString()).toBe(Usd.parse("0.065").toString());
  });

  test("selects the tier whose criteria the metrics satisfy", async () => {
    const pricing = parseReplicatePricing(await fixture("retro-diffusion_rd-plus"))!;
    const classic64 = predictionCost(pricing, {
      model_variant: "rd_plus_classic",
      image_output_pixel_count: 4096,
      image_output_count: 1,
    });
    expect(classic64.toString()).toBe(Usd.parse("0.03").toString());
    const large384 = predictionCost(pricing, {
      model_variant: "rd_plus_large",
      image_output_pixel_count: 200_000,
      image_output_count: 2,
    });
    expect(large384.toString()).toBe(Usd.parse("0.198").toString());
  });

  test("charges the most expensive tier when metrics cannot decide", async () => {
    const pricing = parseReplicatePricing(await fixture("retro-diffusion_rd-plus"))!;
    const cost = predictionCost(pricing, { image_output_count: 1 });
    expect(cost.toString()).toBe(Usd.parse("0.099").toString());
  });
});

describe("estimatePredictionCost", () => {
  test("holds a multiple of the median run for hardware models", async () => {
    const pricing = parseReplicatePricing(await fixture("lucataco_remove-bg"))!;
    expect(estimatePredictionCost(pricing, {}).toString()).toBe(
      Usd.parse("0.00132").toString(),
    );
  });

  test("sizes the hold from input text for character and token metrics", async () => {
    const pricing = parseReplicatePricing(await fixture("minimax_speech-02-turbo"))!;
    const estimate = estimatePredictionCost(pricing, { text: "a".repeat(2000), voice: "x" });
    // 2001 string characters counted as tokens at $0.00006 each.
    expect(estimate.toString()).toBe(Usd.parse("0.12006").toString());
  });

  test("never holds less than the median run", async () => {
    const pricing = parseReplicatePricing(await fixture("minimax_speech-02-turbo"))!;
    const estimate = estimatePredictionCost(pricing, {});
    expect(estimate.toAtoms() >= (pricing.medianRunUsd?.toAtoms() ?? 0n)).toBeTrue();
  });
});

describe("describePricing", () => {
  test("summarises both pricing kinds", async () => {
    const hardware = parseReplicatePricing(await fixture("lucataco_remove-bg"))!;
    expect(describePricing(hardware)).toBe("≈ $0.00033 per run · $0.000225/s on T4");
    const perUnit = parseReplicatePricing(await fixture("minimax_speech-02-turbo"))!;
    expect(describePricing(perUnit)).toBe("$0.06 per thousand input tokens");
  });
});

describe("scaleUsd", () => {
  test("multiplies by fractional units without float drift", () => {
    expect(scaleUsd(Usd.parse("0.001"), 0.3).toString()).toBe(Usd.parse("0.0003").toString());
    expect(scaleUsd(Usd.parse("1"), 0).toString()).toBe(Usd.zero.toString());
  });
});

describe("createReplicatePricingSource", () => {
  test("caches, single-flights, and serves stale values on refresh failure", async () => {
    const html = await fixture("lucataco_remove-bg");
    let calls = 0;
    let fail = false;
    const fetchStub = (async (_input: RequestInfo | URL) => {
      calls += 1;
      return fail ? new Response("down", { status: 503 }) : new Response(html);
    }) as typeof fetch;
    const source = createReplicatePricingSource({ fetch: fetchStub, ttlMs: 1 });
    const [a, b] = await Promise.all([source.get("lucataco/remove-bg"), source.get("lucataco/remove-bg")]);
    expect(calls).toBe(1);
    expect(a?.kind).toBe("hardware");
    expect(b).toBe(a);

    await Bun.sleep(5);
    fail = true;
    const stale = await source.get("lucataco/remove-bg");
    expect(stale?.kind).toBe("hardware");
    expect(calls).toBe(2);
  });

  test("rejects when there is no cached value and the fetch fails", async () => {
    const source = createReplicatePricingSource({
      fetch: (async (_input: RequestInfo | URL) => new Response("down", { status: 503 })) as typeof fetch,
    });
    await expect(source.get("x/y")).rejects.toThrow("HTTP 503");
  });
});
