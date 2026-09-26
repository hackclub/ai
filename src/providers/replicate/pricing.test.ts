import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import {
  describePricing,
  estimatePredictionCost,
  hasBillableMetrics,
  parseReplicatePricing,
  predictionCost,
  type ReplicatePricing,
} from "./pricing";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}.html`, import.meta.url)).text();

const pricingFor = async (name: string) => {
  const pricing = parseReplicatePricing(await fixture(name));
  if (!pricing) throw new Error(`no pricing in ${name}`);
  return pricing;
};

const perUnit = async (name: string) => {
  const pricing = await pricingFor(name);
  if (pricing.kind !== "per-unit") throw new Error("expected per-unit pricing");
  return pricing;
};

/** Canonical string form of a dollar amount, for comparing with `Usd#toString`. */
const usd = (value: string) => Usd.parse(value).toString();

describe("parseReplicatePricing", () => {
  test("reads the hardware per-second rate for a community model", async () => {
    const pricing = await pricingFor("lucataco_remove-bg");
    if (pricing.kind !== "hardware") throw new Error("expected hardware pricing");
    expect(pricing.hardware).toBe("T4");
    expect(pricing.perSecondUsd.toString()).toBe(usd("0.000225"));
    expect(pricing.medianRunUsd?.toString()).toBe(usd("0.00033"));
  });

  test("reads per-thousand unit prices for an official model", async () => {
    const pricing = await perUnit("minimax_speech-02-turbo");
    expect(pricing.tiers).toHaveLength(1);
    const [price] = pricing.tiers[0]!.prices;
    expect(price?.metric).toBe("token_input_count");
    // $0.06 per thousand input tokens.
    expect(price?.unitUsd.toString()).toBe(usd("0.00006"));
  });

  test("reads whole-dollar per-thousand prices", async () => {
    const pricing = await perUnit("recraft-ai_recraft-crisp-upscale");
    // $6 per thousand output images.
    expect(pricing.tiers[0]!.prices[0]!.unitUsd.toString()).toBe(usd("0.006"));
  });

  test("reads tiered pricing with criteria", async () => {
    const pricing = await perUnit("retro-diffusion_rd-plus");
    expect(pricing.tiers.length).toBeGreaterThan(5);
    expect(pricing.tiers[0]!.criteria).toEqual([
      { type: "equals", title: "model variant", value: "rd_plus_classic" },
      { type: "range", title: "output image pixel", min: null, max: 1024 },
    ]);
  });

  test.each([
    "<html><body>nothing</body></html>",
    '<script id="react-component-props-x" type="application/json">{"billingConfig": null}</script>',
  ])("returns null when the page carries no pricing: %s", (html) => {
    expect(parseReplicatePricing(html)).toBeNull();
  });
});

describe("predictionCost", () => {
  test.each([
    ["the matching metric", "minimax_speech-02-turbo", { token_input_count: 500, predict_time: 9 }, "0.03"],
    // $2 per thousand seconds; 32.5 seconds.
    ["fractional units such as seconds of audio", "google_lyria-2", { audio_output_duration_seconds: 32.5 }, "0.065"],
    [
      "the tier whose criteria the metrics satisfy (classic 64px)",
      "retro-diffusion_rd-plus",
      { model_variant: "rd_plus_classic", image_output_pixel_count: 4096, image_output_count: 1 },
      "0.03",
    ],
    [
      "the tier whose criteria the metrics satisfy (large 384px)",
      "retro-diffusion_rd-plus",
      { model_variant: "rd_plus_large", image_output_pixel_count: 200_000, image_output_count: 2 },
      "0.198",
    ],
    ["the most expensive tier when metrics cannot decide", "retro-diffusion_rd-plus", { image_output_count: 1 }, "0.099"],
  ])("bills per-unit models on %s", async (_name, model, metrics, expected) => {
    expect(predictionCost(await pricingFor(model), metrics).toString()).toBe(usd(expected));
  });
});

test("hasBillableMetrics requires the metric each pricing kind is keyed on", () => {
  const hardware: ReplicatePricing = {
    kind: "hardware",
    hardware: "T4",
    perSecondUsd: Usd.parse("0.001"),
    medianRunUsd: null,
  };
  expect(hasBillableMetrics(hardware, { predict_time: 0 })).toBeTrue();
  expect(hasBillableMetrics(hardware, { total_time: 2 })).toBeFalse();
  expect(hasBillableMetrics(hardware, {})).toBeFalse();

  const perUnitPricing: ReplicatePricing = {
    kind: "per-unit",
    hardware: "A100",
    medianRunUsd: null,
    tiers: [
      {
        title: null,
        criteria: [],
        prices: [{ metric: "image_output_count", display: "image", unitUsd: Usd.parse("0.01"), title: "per image" }],
      },
    ],
  };
  expect(hasBillableMetrics(perUnitPricing, { image_output_count: 2 })).toBeTrue();
  expect(hasBillableMetrics(perUnitPricing, { predict_time: 2 })).toBeFalse();
});

describe("estimatePredictionCost", () => {
  test("holds a multiple of the median run for hardware models", async () => {
    const pricing = await pricingFor("lucataco_remove-bg");
    expect(estimatePredictionCost(pricing, {}).toString()).toBe(usd("0.00132"));
  });

  test("sizes the hold from input text for character and token metrics", async () => {
    const pricing = await pricingFor("minimax_speech-02-turbo");
    // 2001 string characters counted as tokens at $0.00006 each.
    const estimate = estimatePredictionCost(pricing, { text: "a".repeat(2000), voice: "x" });
    expect(estimate.toString()).toBe(usd("0.12006"));
  });

  test("never holds less than the median run", async () => {
    const pricing = await pricingFor("minimax_speech-02-turbo");
    const estimate = estimatePredictionCost(pricing, {});
    expect(estimate.toAtoms() >= (pricing.medianRunUsd?.toAtoms() ?? 0n)).toBeTrue();
  });
});

test("describePricing summarises both pricing kinds", async () => {
  expect(describePricing(await pricingFor("lucataco_remove-bg"))).toBe("≈ $0.00033 per run · $0.000225/s on T4");
  expect(describePricing(await pricingFor("minimax_speech-02-turbo"))).toBe("$0.06 per thousand input tokens");
});
