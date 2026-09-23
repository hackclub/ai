import type { ProviderModule } from "../provider";
import { fetchOpenRouterGeneration, type OpenRouterConfig } from "./generation";

export const OPENROUTER = "openrouter";

/** A pending OpenRouter request is settled from its generation metadata. */
export const openRouterProvider = (config: OpenRouterConfig): ProviderModule => ({
  key: OPENROUTER,
  reconcile: async (generationId) => {
    const lookup = await fetchOpenRouterGeneration(generationId, config);
    if (lookup.state === "not_found") return { state: "not_found" };
    const { generation } = lookup;
    return {
      state: "charged",
      costUsd: generation.totalCostUsd,
      model: generation.model,
      inputTokens: generation.promptTokens,
      outputTokens: generation.completionTokens,
    };
  },
});
