import { Usd } from "../../billing/money";
import { nonNegativeInteger } from "../values";

export type OpenRouterConfig = {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
};

export type GenerationRecord = {
  id: string;
  totalCostUsd: Usd;
  promptTokens: number;
  completionTokens: number;
  model: string;
};

export type GenerationLookup =
  | { state: "found"; generation: GenerationRecord }
  | { state: "not_found" };

/**
 * OpenRouter's generation metadata endpoint. Returns `not_found` for 404,
 * which OpenRouter also uses while a generation is still being recorded.
 */
export async function fetchOpenRouterGeneration(
  generationId: string,
  config: OpenRouterConfig,
): Promise<GenerationLookup> {
  const fetchImplementation = config.fetch ?? fetch;
  const url = new URL(`${config.baseUrl.replace(/\/$/, "")}/v1/generation`);
  url.searchParams.set("id", generationId);
  const response = await fetchImplementation(url, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (response.status === 404) return { state: "not_found" };
  if (!response.ok) {
    throw new Error(`OpenRouter generation lookup failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    data?: {
      id?: string;
      model?: string;
      total_cost?: number;
      native_tokens_prompt?: number;
      native_tokens_completion?: number;
      usage?: number;
    };
  };
  const data = body.data;
  if (!data) return { state: "not_found" };

  const cost =
    typeof data.total_cost === "number"
      ? data.total_cost
      : typeof data.usage === "number"
        ? data.usage
        : null;
  if (cost === null || cost < 0) {
    throw new Error(`OpenRouter generation ${generationId} has no usable cost`);
  }

  return {
    state: "found",
    generation: {
      id: data.id ?? generationId,
      totalCostUsd: Usd.fromNumber(cost),
      promptTokens: nonNegativeInteger(data.native_tokens_prompt) ?? 0,
      completionTokens: nonNegativeInteger(data.native_tokens_completion) ?? 0,
      model: typeof data.model === "string" ? data.model : "",
    },
  };
}
