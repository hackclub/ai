import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import {
  JEV_MODEL,
  jevCost,
  jevModelLabel,
  jevResponseModel,
  jevTokens,
  TYPESAFE,
  typesafeProvider,
} from "./provider";

const price = Usd.parse("0.042");

describe("typesafe provider", () => {
  test("reserves under the typesafe key and declares no lookup", () => {
    expect(TYPESAFE).toBe("typesafe");
    expect(typesafeProvider).toEqual({ key: "typesafe", reconcile: null });
  });

  test("jevTokens reads usage and defaults missing output tokens to zero", () => {
    expect(jevTokens({ usage: { input_tokens: 1_000, output_tokens: 20 } })).toEqual({
      inputTokens: 1_000,
      outputTokens: 20,
    });
    expect(jevTokens({ usage: { input_tokens: 5 } })).toEqual({ inputTokens: 5, outputTokens: 0 });
  });

  test("jevTokens is null without usable input tokens", () => {
    expect(jevTokens({})).toBeNull();
    expect(jevTokens({ usage: null })).toBeNull();
    expect(jevTokens({ usage: { input_tokens: -1 } })).toBeNull();
    expect(jevTokens({ usage: { input_tokens: 1.5 } })).toBeNull();
  });

  test("jevCost prices input tokens per million; output is free", () => {
    const cost = jevCost({ usage: { input_tokens: 1_000, output_tokens: 1_000_000 } }, price);
    expect(cost?.equals(Usd.parse("0.000042"))).toBe(true);
    expect(jevCost({}, price)).toBeNull();
  });

  test("jevModelLabel prefers the reported model over the requested alias", () => {
    expect(jevModelLabel("jev-1.13.0", "jev-latest")).toBe("jev/jev-1.13.0");
    expect(jevModelLabel(null, "jev-latest")).toBe("jev/jev-latest");
    expect(jevModelLabel(undefined)).toBe("jev/jev-latest");
    expect(jevModelLabel("", "")).toBe("jev/jev-latest");
  });

  test("jevResponseModel reads the model from a raw body", () => {
    expect(jevResponseModel(JSON.stringify({ model: "jev-1.13.0" }))).toBe("jev-1.13.0");
    expect(jevResponseModel("{}")).toBeNull();
    expect(jevResponseModel("not json")).toBeNull();
  });

  test("JEV_MODEL accepts only the Jev family", () => {
    expect(JEV_MODEL.test("jev-latest")).toBe(true);
    expect(JEV_MODEL.test("jev")).toBe(true);
    expect(JEV_MODEL.test("gpt-4")).toBe(false);
  });
});
