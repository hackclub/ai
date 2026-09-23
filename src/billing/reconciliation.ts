import type postgres from "postgres";

import { reconciledObservation } from "../analytics/request-event";
import type { BillingEngine } from "./engine";
import type { Usd } from "./money";

type Sql = postgres.Sql;

export type ReconcileOptions = {
  sql: Sql;
  billing: Pick<BillingEngine, "finalize" | "release">;
  /** The lookup for each provider key; a key without one is released after `maxAgeMs`. */
  providers: ProviderLookups;
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
  endpoint: string | null;
  expired: boolean;
  age_ms: number | string;
};

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** What a provider lookup found for a pending reservation. */
export type ProviderCharge =
  | { state: "charged"; costUsd: Usd; model: string; inputTokens: number; outputTokens: number }
  | { state: "not_found" }
  | { state: "not_ready"; detail: string };

/** Looks up what the provider charged for one request id. Throws on transient failure. */
export type ChargeLookup = (providerRequestId: string) => Promise<ProviderCharge>;

/** What reconciliation needs from the providers: a lookup per provider key, or none. */
export type ProviderLookups = { lookupFor(provider: string): ChargeLookup | null };

/**
 * Moves a row the pass could not settle to the back of the queue so a
 * backlog of not-ready rows cannot starve newer ones. Touches only
 * `updated_at`; billing state is untouched, which is why this UPDATE lives
 * here rather than in the engine.
 */
const deferRow = (sql: Sql, requestId: string) =>
  sql`
    UPDATE billing_reservations
    SET updated_at = now()
    WHERE request_id = ${requestId}::uuid AND state = 'pending_reconciliation'
  `;

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
      endpoint,
      created_at < now() - make_interval(secs => ${maxAgeMs / 1_000}) AS expired,
      floor(extract(epoch FROM (now() - created_at)) * 1000)::bigint AS age_ms
    FROM billing_reservations
    WHERE state = 'pending_reconciliation'
    ORDER BY updated_at ASC
    LIMIT ${options.limit ?? 100}
  `;

  const lookupCharge = (row: PendingRow): Promise<ProviderCharge> | null => {
    if (!row.provider_request_id) return null;
    const lookup = options.providers.lookupFor(row.provider);
    return lookup ? lookup(row.provider_request_id) : null;
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
          await deferRow(options.sql, row.request_id);
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
          await deferRow(options.sql, row.request_id);
          result.skipped += 1;
        }
        continue;
      }
      if (charge.state === "not_ready") {
        // The provider knows the request, so the hold is kept until the
        // record can be billed, however long that takes.
        log(`skipped ${row.request_id}: ${charge.detail}`);
        await deferRow(options.sql, row.request_id);
        result.skipped += 1;
        continue;
      }

      await options.billing.finalize({
        requestId: row.request_id,
        actualCostUsd: charge.costUsd,
        usageSource: "reconciled",
        providerRequestId: row.provider_request_id ?? undefined,
        request: reconciledObservation(charge, {
          endpoint: row.endpoint,
          reconciliationReason: row.reconciliation_reason,
        }),
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
