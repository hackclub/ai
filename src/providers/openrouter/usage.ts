import { Usd } from "../../billing/money";
import type { NormalizedUsage } from "../types";
import { nonNegativeInteger } from "../values";

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const cost = (value: unknown): Usd | null => {
  try {
    if (typeof value === "number") {
      const parsed = Usd.fromNumber(value);
      return parsed.isNegative() ? null : parsed;
    }
    if (typeof value === "string") {
      const parsed = Usd.parse(value);
      return parsed.isNegative() ? null : parsed;
    }
  } catch {
    return null;
  }
  return null;
};

export const openRouterRequestId = (value: unknown): string | null => {
  const root = asRecord(value);
  if (!root) return null;
  if (typeof root.id === "string") return root.id;

  const response = asRecord(root.response);
  return response && typeof response.id === "string" ? response.id : null;
};

export const openRouterUsage = (value: unknown): NormalizedUsage | null => {
  const root = asRecord(value);
  if (!root) return null;

  const response = asRecord(root.response);
  const usage = asRecord(root.usage) ?? asRecord(response?.usage);
  if (!usage) return null;

  const costDetails = asRecord(usage.cost_details);
  const totalCost =
    cost(usage.cost) ?? cost(costDetails?.upstream_inference_cost);
  if (!totalCost) return null;

  const inputTokens =
    nonNegativeInteger(usage.prompt_tokens ?? usage.input_tokens) ?? 0;
  const outputTokens =
    nonNegativeInteger(usage.completion_tokens ?? usage.output_tokens) ?? 0;
  const reportedTotal = nonNegativeInteger(usage.total_tokens) ?? 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
    costUsd: totalCost,
  };
};
