import type postgres from "postgres";

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

export type ReconcileOptions = {
  sql: Sql;
  billing: Pick<BillingEngine, "finalize" | "release">;
  openRouter: OpenRouterConfig;
  now?: () => Date;
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
  updated_at: Date;
};

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Settles reservations the gateway could not settle at request time
 * (client cancellation, truncated stream, missing usage). OpenRouter's
 * generation record supplies the real charge. Idempotent: the engine's
 * account locks and state checks make concurrent runs safe, and every row
 * is handled independently so one failure does not stop the batch.
 */
export async function reconcilePendingReservations(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const log = options.log ?? (() => {});
  const result: ReconcileResult = { finalized: 0, released: 0, skipped: 0, failed: 0 };

  const rows = await options.sql<PendingRow[]>`
    SELECT request_id, provider, provider_request_id, reconciliation_reason, updated_at
    FROM billing_reservations
    WHERE state = 'pending_reconciliation'
    ORDER BY updated_at ASC
    LIMIT ${options.limit ?? 100}
  `;

  for (const row of rows) {
    const ageMs = now().getTime() - row.updated_at.getTime();
    const expired = ageMs >= maxAgeMs;
    try {
      if (row.provider !== "openrouter" || !row.provider_request_id) {
        if (expired) {
          await options.billing.release(row.request_id);
          log(`released ${row.request_id}: no provider record to reconcile after ${ageMs}ms`);
          result.released += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const lookup = await fetchOpenRouterGeneration(
        row.provider_request_id,
        options.openRouter,
      );
      if (lookup.state === "not_found") {
        if (expired) {
          await options.billing.release(row.request_id);
          log(`released ${row.request_id}: OpenRouter has no generation ${row.provider_request_id}`);
          result.released += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const { generation } = lookup;
      const analytics: Record<string, JsonValue> = {
        endpoint: "",
        model: generation.model,
        outcome: "reconciled",
        error_code: "",
        http_status: 0,
        streamed: false,
        duration_ms: 0,
        time_to_first_byte_ms: null,
        input_tokens: generation.promptTokens,
        output_tokens: generation.completionTokens,
        provider_cost_usd: generation.totalCostUsd.toString(),
        request_headers: {},
        response_headers: {},
        attributes: {
          body_capture: "none",
          reconciliation_reason: row.reconciliation_reason ?? "",
        },
        request_body: "",
        response_body: "",
      };
      await options.billing.finalize({
        requestId: row.request_id,
        actualCostUsd: generation.totalCostUsd,
        usageSource: "reconciled",
        providerRequestId: row.provider_request_id,
        analytics,
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
