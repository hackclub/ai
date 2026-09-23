import { Usd } from "../../billing/money";
import type { ProviderModule } from "../provider";
import { nonNegativeInteger } from "../values";

export const TYPESAFE = "typesafe";

export const DEFAULT_JEV_MODEL = "jev-latest";
const TOKENS_PER_PRICE_UNIT = 1_000_000n;
/**
 * The configured input price is Jev's. Any other model TypeSafe might serve
 * is priced differently, so only the Jev family is forwarded.
 */
export const JEV_MODEL = /^jev(-[a-z0-9.]+)?$/i;

/** `usage.input_tokens` / `usage.output_tokens` from a systemone response, or null when absent. */
export const jevTokens = (body: unknown): { inputTokens: number; outputTokens: number } | null => {
  if (body === null || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return null;
  const { input_tokens, output_tokens } = usage as { input_tokens?: unknown; output_tokens?: unknown };
  const inputTokens = nonNegativeInteger(input_tokens);
  if (inputTokens === null) return null;
  return { inputTokens, outputTokens: nonNegativeInteger(output_tokens) ?? 0 };
};

/** Input tokens priced at `pricePerMillion`; output tokens are free. Null without usage. */
export const jevCost = (body: unknown, pricePerMillion: Usd): Usd | null => {
  const tokens = jevTokens(body);
  if (!tokens) return null;
  return Usd.fromAtoms((pricePerMillion.toAtoms() * BigInt(tokens.inputTokens)) / TOKENS_PER_PRICE_UNIT);
};

/** `jev/<model>`, preferring the versioned id the response reports over the alias requested. */
export const jevModelLabel = (model: unknown, fallback: unknown = DEFAULT_JEV_MODEL) => {
  const chosen = typeof model === "string" && model ? model : fallback;
  return `jev/${typeof chosen === "string" && chosen ? chosen : DEFAULT_JEV_MODEL}`;
};

/** The `model` a raw systemone response reports, or null. */
export const jevResponseModel = (raw: string): string | null => {
  try {
    const model = (JSON.parse(raw) as { model?: unknown })?.model;
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
};

/** No lookup: a pending Jev hold is released after the max age without a charge. */
export const typesafeProvider: ProviderModule = { key: TYPESAFE, reconcile: null };
