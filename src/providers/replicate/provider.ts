import type { ProviderModule } from "../provider";
import { predictionCharge } from "./billing";
import { fetchReplicatePrediction, isTerminal, type ReplicateConfig } from "./predictions";
import type { ReplicatePricingSource } from "./pricing";

export type ReplicateProviderConfig = ReplicateConfig & { pricing: ReplicatePricingSource };

export const REPLICATE = "replicate";
export const REPLICATE_FILES = "replicate-files";

/**
 * A pending prediction is billed from its terminal metrics and the live
 * pricing of the model that ran it, through the same rule live metering
 * uses. One still running, or a succeeded one whose metrics lack the priced
 * value, is left pending for the next pass.
 */
export const replicateProvider = (config: ReplicateProviderConfig): ProviderModule => ({
  key: REPLICATE,
  reconcile: async (predictionId) => {
    const lookup = await fetchReplicatePrediction(predictionId, config);
    if (lookup.state === "not_found") return { state: "not_found" };
    const { prediction } = lookup;
    if (!isTerminal(prediction)) {
      return { state: "not_ready", detail: `prediction is ${prediction.status ?? "unknown"}` };
    }
    if (!prediction.model) {
      return { state: "not_ready", detail: "prediction reports no model" };
    }
    const pricing = await config.pricing.get(prediction.model);
    if (!pricing) return { state: "not_ready", detail: `no pricing for ${prediction.model}` };
    const charge = predictionCharge(prediction, pricing);
    if (charge.state === "not_ready") return charge;
    return {
      state: "charged",
      costUsd: charge.costUsd,
      model: prediction.model,
      inputTokens: 0,
      outputTokens: 0,
    };
  },
});

/** File uploads are free and have nothing to look up. */
export const replicateFilesProvider: ProviderModule = { key: REPLICATE_FILES, reconcile: null };
