import type { Usd } from "../../billing/money";
import type { TerminalPrediction } from "./predictions";
import { hasBillableMetrics, predictionCost, type ReplicatePricing } from "./pricing";

export type PredictionCharge =
  | { state: "charged"; costUsd: Usd }
  | { state: "not_ready"; detail: string };

/**
 * What a finished prediction costs under `pricing`. Failed and cancelled
 * runs bill any hardware time Replicate reports; a succeeded run without
 * the metric its price is keyed on cannot be billed yet.
 *
 * Live metering and reconciliation both bill through this one rule, so the
 * two paths cannot charge a prediction differently.
 */
export const predictionCharge = (
  prediction: TerminalPrediction,
  pricing: ReplicatePricing,
): PredictionCharge => {
  const metrics = prediction.metrics ?? {};
  if (prediction.status === "succeeded" && !hasBillableMetrics(pricing, metrics)) {
    return { state: "not_ready", detail: "succeeded without billable metrics" };
  }
  return { state: "charged", costUsd: predictionCost(pricing, metrics) };
};
