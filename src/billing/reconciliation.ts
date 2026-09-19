import type postgres from "postgres";

import {
  fetchReplicatePrediction,
  isTerminal,
  type ReplicateConfig,
} from "../providers/replicate/predictions";
import {
  hasBillableMetrics,
  predictionCost,
  type ReplicatePricingSource,
} from "../providers/replicate/pricing";
import type { BillingEngine, JsonValue } from "./engine";
import { Usd } from "./money";

type Sql = postgres.Sql;

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

const nonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

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
      promptTokens: nonNegativeInteger(data.native_tokens_prompt),
      completionTokens: nonNegativeInteger(data.native_tokens_completion),
      model: typeof data.model === "string" ? data.model : "",
    },
  };
}

export type ReplicateReconcileConfig = ReplicateConfig & {
  pricing: ReplicatePricingSource;
};

export type ReconcileOptions = {
  sql: Sql;
  billing: Pick<BillingEngine, "finalize" | "release">;
  openRouter: OpenRouterConfig;
  /** Enables reconciling Replicate predictions; without it they are skipped until released. */
  replicate?: ReplicateReconcileConfig;
  /** Age after which a reservation without a provider record is released. */
  maxAgeMs?: number;
  limit?: number;
  log?: (message: string) => void;
};

export type ReconcileResult = {
  finalized: number;
  released: number;
  skipped: number;
  failed: number;
};

type PendingRow = {
  request_id: string;
  provider: string;
  provider_request_id: string | null;
  reconciliation_reason: string | null;
  expired: boolean;
  age_ms: number | string;
};

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** What a provider lookup found for a pending reservation. */
type ProviderCharge =
  | { state: "charged"; costUsd: Usd; model: string; inputTokens: number; outputTokens: number }
  | { state: "not_found" }
  | { state: "not_ready"; detail: string };

const reconciledAnalytics = (
  row: PendingRow,
  charge: Extract<ProviderCharge, { state: "charged" }>,
): Record<string, JsonValue> => ({
  endpoint: "",
  model: charge.model,
  outcome: "reconciled",
  error_code: "",
  http_status: 0,
  streamed: false,
  duration_ms: 0,
  time_to_first_byte_ms: null,
  input_tokens: charge.inputTokens,
  output_tokens: charge.outputTokens,
  provider_cost_usd: charge.costUsd.toString(),
  request_headers: {},
  response_headers: {},
  attributes: {
    body_capture: "none",
    reconciliation_reason: row.reconciliation_reason ?? "",
  },
  request_body: "",
  response_body: "",
});

const openRouterCharge = async (
  providerRequestId: string,
  config: OpenRouterConfig,
): Promise<ProviderCharge> => {
  const lookup = await fetchOpenRouterGeneration(providerRequestId, config);
  if (lookup.state === "not_found") return { state: "not_found" };
  const { generation } = lookup;
  return {
    state: "charged",
    costUsd: generation.totalCostUsd,
    model: generation.model,
    inputTokens: generation.promptTokens,
    outputTokens: generation.completionTokens,
  };
};

/**
 * A Replicate prediction is billed from its terminal metrics and the live
 * pricing of the model that ran it. One still running, or a succeeded one
 * whose metrics lack the priced value, is left pending for the next pass.
 */
const replicateCharge = async (
  predictionId: string,
  config: ReplicateReconcileConfig,
): Promise<ProviderCharge> => {
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
  const metrics = prediction.metrics ?? {};
  if (prediction.status === "succeeded" && !hasBillableMetrics(pricing, metrics)) {
    return { state: "not_ready", detail: "succeeded without billable metrics" };
  }
  return {
    state: "charged",
    costUsd: predictionCost(pricing, metrics),
    model: prediction.model,
    inputTokens: 0,
    outputTokens: 0,
  };
};

/**
 * Settles reservations the gateway could not settle at request time
 * (client cancellation, truncated stream, missing usage, a prediction that
 * outlived the settlement window). The provider's own record supplies the
 * real charge. Idempotent: the engine's account locks and state checks make
 * concurrent runs safe, and every row is handled independently so one
 * failure does not stop the batch.
 */
export async function reconcilePendingReservations(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const log = options.log ?? (() => {});
  const result: ReconcileResult = { finalized: 0, released: 0, skipped: 0, failed: 0 };

  const rows = await options.sql<PendingRow[]>`
    SELECT
      request_id,
      provider,
      provider_request_id,
      reconciliation_reason,
      created_at < now() - make_interval(secs => ${maxAgeMs / 1_000}) AS expired,
      floor(extract(epoch FROM (now() - updated_at)) * 1000)::bigint AS age_ms
    FROM billing_reservations
    WHERE state = 'pending_reconciliation'
    ORDER BY updated_at ASC
    LIMIT ${options.limit ?? 100}
  `;

  const lookupCharge = (row: PendingRow): Promise<ProviderCharge> | null => {
    if (!row.provider_request_id) return null;
    if (row.provider === "openrouter") {
      return openRouterCharge(row.provider_request_id, options.openRouter);
    }
    if (row.provider === "replicate" && options.replicate) {
      return replicateCharge(row.provider_request_id, options.replicate);
    }
    return null;
  };

  for (const row of rows) {
    const { expired } = row;
    const ageMs = Number(row.age_ms);
    try {
      const pending = lookupCharge(row);
      if (!pending) {
        if (expired) {
          await options.billing.release(row.request_id);
          log(`released ${row.request_id}: no provider record to reconcile after ${ageMs}ms`);
          result.released += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const charge = await pending;
      if (charge.state === "not_found") {
        if (expired) {
          await options.billing.release(row.request_id);
          log(
            `released ${row.request_id}: ${row.provider} has no record ${row.provider_request_id}`,
          );
          result.released += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (charge.state === "not_ready") {
        // The provider knows the request, so the hold is kept until the
        // record can be billed, however long that takes.
        log(`skipped ${row.request_id}: ${charge.detail}`);
        result.skipped += 1;
        continue;
      }

      await options.billing.finalize({
        requestId: row.request_id,
        actualCostUsd: charge.costUsd,
        usageSource: "reconciled",
        providerRequestId: row.provider_request_id ?? undefined,
        analytics: reconciledAnalytics(row, charge),
      });
      result.finalized += 1;
    } catch (error) {
      result.failed += 1;
      log(
        `failed to reconcile ${row.request_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

export type ExpireOptions = {
  sql: Sql;
  billing: Pick<BillingEngine, "release">;
  limit?: number;
  log?: (message: string) => void;
};

/**
 * Releases reservations still `reserved` past their expiry: the process
 * that made them died before settling, so the hold would otherwise pin
 * funding forever. Reservations that reached pending_reconciliation are
 * handled by reconcilePendingReservations instead.
 */
export async function expireStaleReservations(
  options: ExpireOptions,
): Promise<{ released: number; failed: number }> {
  const log = options.log ?? (() => {});
  const rows = await options.sql<{ request_id: string }[]>`
    SELECT request_id
    FROM billing_reservations
    WHERE state = 'reserved' AND expires_at < now()
    ORDER BY expires_at ASC
    LIMIT ${options.limit ?? 100}
  `;
  const result = { released: 0, failed: 0 };
  for (const row of rows) {
    try {
      await options.billing.release(row.request_id);
      log(`released expired reservation ${row.request_id}`);
      result.released += 1;
    } catch (error) {
      result.failed += 1;
      log(
        `failed to release ${row.request_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return result;
}
