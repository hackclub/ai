import type postgres from "postgres";

import { ReservationConflictError, ReservationNotFoundError } from "./errors";
import { releaseAllHolds, writeHoldChange } from "./holds";
import { type ReservationState, transition } from "./lifecycle";
import {
  lockAccount,
  lockAvailableCredits,
  lockAvailableWindows,
  lockCreditHolds,
  lockLimitHolds,
  lockLimitWindows,
  lockReservation,
  lockReservationAccount,
  lockWindowHolds,
  requireReservation,
  reservationColumns,
  type ReservationRow,
  type Statement,
  toFundingHolds,
  toFundingSources,
  toLimitHolds,
  toLimitWindows,
} from "./locks";
import { Usd } from "./money";
import {
  type LimitWindow,
  needsCurrentLimitWindows,
  planFinalize,
  planReserve,
} from "./plan";
import {
  materializeFundingWindows,
  materializeLimitWindows,
} from "./windows";

export type { ReservationState } from "./lifecycle";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type UsageSource =
  | "provider_reported"
  | "calculated"
  | "reconciled"
  | "fallback"
  | "manual";

export type Reservation = {
  id: string;
  requestId: string;
  accountId: string;
  provider: string;
  providerRequestId: string | null;
  state: ReservationState;
  estimatedCostUsd: string;
  actualCostUsd: string | null;
  unfundedCostUsd: string;
  expiresAt: Date;
};

export type ReserveInput = {
  requestId: string;
  accountId: string;
  provider: string;
  estimatedCostUsd: Usd;
  /** How long the hold may stay `reserved` before the sweeper releases it. Measured on the PostgreSQL clock. */
  ttlMs?: number;
};

export type FinalizeInput = {
  requestId: string;
  actualCostUsd: Usd;
  usageSource: UsageSource;
  providerRequestId?: string;
  analytics?: Record<string, JsonValue>;
};

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1_000;

const UNIQUE_VIOLATION = "23505";

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === UNIQUE_VIOLATION;

const toReservation = (row: ReservationRow): Reservation => ({
  id: row.id,
  requestId: row.request_id,
  accountId: row.account_id,
  provider: row.provider,
  providerRequestId: row.provider_request_id,
  state: row.state,
  estimatedCostUsd: Usd.parse(row.estimated_cost_usd).toString(),
  actualCostUsd:
    row.actual_cost_usd === null
      ? null
      : Usd.parse(row.actual_cost_usd).toString(),
  unfundedCostUsd: Usd.parse(row.unfunded_cost_usd).toString(),
  expiresAt: row.expires_at,
});

/** The first row a pipelined write returned, or a loud failure. */
const returnedRow = (rows: unknown, operation: string): ReservationRow => {
  const row = (rows as ReservationRow[])[0];
  if (!row) throw new Error(`PostgreSQL did not return the ${operation} reservation`);
  return row;
};

/**
 * Reservation engine over PostgreSQL. The only writer of `billing_*`
 * counters and holds; see src/billing/README.md for the model.
 *
 * Every operation has the same four steps:
 *
 * 1. **Lock** the account (advisory lock). All time comes from SQL
 *    `now()`, fixed for the transaction; see locks.ts.
 * 2. **Read** the rows the operation needs, with row locks, in one
 *    pipelined round trip.
 * 3. **Plan** in plain TypeScript (lifecycle.ts decides whether the
 *    operation applies; plan.ts decides where the money goes).
 * 4. **Write** the plan in one pipelined round trip.
 *
 * The account lock serializes every operation on one account, so the time
 * spent holding it bounds a busy account's throughput. That is why reads
 * and writes are each one round trip: statements issued together through
 * `Promise.all` on the transaction connection are sent without waiting for
 * earlier replies, and execute in issue order.
 */
export class BillingEngine {
  constructor(private readonly sql: Sql) {}

  /**
   * Holds the estimate in funding and in every limit window, before the
   * provider is called. Retrying with the same request id returns the
   * same live hold.
   */
  async reserve(input: ReserveInput): Promise<Reservation> {
    if (input.estimatedCostUsd.isNegative()) {
      throw new RangeError("estimatedCostUsd must not be negative");
    }
    const ttlMs = input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive number of milliseconds");
    }

    return this.sql.begin(async (tx) => {
      // Concurrent reserves for one request id share an account, so the
      // account lock also serializes idempotent retries.
      await lockAccount(tx, input.accountId);

      // Materialization precedes the locking reads in issue order, so the
      // current windows exist by the time they are locked.
      const [existingRows, , , limitRows, windowRows, creditRows] =
        await Promise.all([
          lockReservation(tx, input.requestId),
          materializeFundingWindows(tx, input.accountId),
          materializeLimitWindows(tx, input.accountId),
          lockLimitWindows(tx, input.accountId),
          lockAvailableWindows(tx, input.accountId),
          lockAvailableCredits(tx, input.accountId),
        ]);

      const existing = existingRows[0];
      if (existing) {
        assertSameReservation(existing, input);
        transition(input.requestId, "reserve", existing.state);
        return toReservation(existing);
      }

      const changes = planReserve(input.estimatedCostUsd, {
        limits: toLimitWindows(limitRows),
        sources: toFundingSources(windowRows, creditRows),
      });

      // The id is generated here so the holds, which reference it, go out
      // in the same round trip as the reservation itself.
      const reservationId = crypto.randomUUID();
      const writes: Statement[] = [
        tx`
          INSERT INTO billing_reservations (
            id,
            request_id,
            account_id,
            provider,
            estimated_cost_usd,
            expires_at
          )
          VALUES (
            ${reservationId}::uuid,
            ${input.requestId}::uuid,
            ${input.accountId}::uuid,
            ${input.provider},
            ${input.estimatedCostUsd.toString()}::numeric,
            now() + ${ttlMs}::double precision * INTERVAL '1 millisecond'
          )
          RETURNING ${reservationColumns(tx)}
        `,
        ...changes.flatMap((change) =>
          writeHoldChange(tx, reservationId, change),
        ),
      ];

      try {
        const [created] = await Promise.all(writes);
        return toReservation(returnedRow(created, "created"));
      } catch (error) {
        // Only a different account reserving the same request id can slip
        // past the account lock and collide on the request id.
        if (isUniqueViolation(error)) {
          throw new ReservationConflictError(input.requestId, "account differs");
        }
        throw error;
      }
    });
  }

  /**
   * Charges the actual cost: converts holds into committed spend, returns
   * the unused rest, and records the ledger entry and analytics event.
   * Repeating with the same cost returns the finalized reservation.
   */
  async finalize(input: FinalizeInput): Promise<Reservation> {
    const actual = input.actualCostUsd;
    if (actual.isNegative()) {
      throw new RangeError("actualCostUsd must not be negative");
    }

    return this.sql.begin(async (tx) => {
      const { accountId, now } = await lockReservationAccount(tx, input.requestId);

      // Available funding is read up front so a cost above the estimate
      // needs no further round trip.
      const [
        reservationRows,
        windowHoldRows,
        creditHoldRows,
        windowRows,
        creditRows,
        limitHoldRows,
      ] = await Promise.all([
        lockReservation(tx, input.requestId),
        lockWindowHolds(tx, input.requestId),
        lockCreditHolds(tx, input.requestId),
        lockAvailableWindows(tx, accountId),
        lockAvailableCredits(tx, accountId),
        lockLimitHolds(tx, input.requestId),
      ]);

      const reservation = reservationRows[0];
      if (!reservation) throw new ReservationNotFoundError(input.requestId);

      if (transition(input.requestId, "finalize", reservation.state) === "replay") {
        if (
          reservation.actual_cost_usd === null ||
          !Usd.parse(reservation.actual_cost_usd).equals(actual)
        ) {
          throw new ReservationConflictError(
            input.requestId,
            "the actual cost differs from the finalized charge",
          );
        }
        return toReservation(reservation);
      }

      const limitHolds = toLimitHolds(limitHoldRows);
      let currentLimits: LimitWindow[] = [];
      if (needsCurrentLimitWindows(limitHolds, actual)) {
        await materializeLimitWindows(tx, accountId);
        currentLimits = toLimitWindows(await lockLimitWindows(tx, accountId));
      }

      const { changes, unfunded } = planFinalize(actual, {
        fundingHolds: toFundingHolds(windowHoldRows, creditHoldRows),
        sources: toFundingSources(windowRows, creditRows),
        limitHolds,
        currentLimits,
      });

      const providerRequestId =
        input.providerRequestId ?? reservation.provider_request_id;

      const writes: Statement[] = [
        ...changes.flatMap((change) =>
          writeHoldChange(tx, reservation.id, change),
        ),
      ];
      if (actual.isPositive()) {
        writes.push(tx`
          INSERT INTO billing_ledger_entries (
            idempotency_key,
            account_id,
            reservation_id,
            direction,
            category,
            amount_usd,
            metadata,
            effective_at
          )
          VALUES (
            ${`usage:${reservation.id}`},
            ${reservation.account_id}::uuid,
            ${reservation.id}::uuid,
            'debit',
            'usage',
            ${actual.toString()}::numeric,
            ${tx.json({
              provider: reservation.provider,
              provider_request_id: providerRequestId,
              usage_source: input.usageSource,
            })},
            now()
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `);
      }

      const updateIndex = writes.length;
      writes.push(tx`
        UPDATE billing_reservations
        SET
          state = 'finalized',
          provider_request_id = ${providerRequestId},
          actual_cost_usd = ${actual.toString()}::numeric,
          unfunded_cost_usd = ${unfunded.toString()}::numeric,
          usage_source = ${input.usageSource},
          reconciliation_reason = NULL,
          finalized_at = now(),
          updated_at = now()
        WHERE id = ${reservation.id}::uuid
        RETURNING ${reservationColumns(tx)}
      `);

      // Same transaction as the ledger and reservation update, so the
      // event exists if and only if the finalization committed. The
      // analytics worker drains the outbox to ClickHouse in batches; see
      // src/analytics/request-events.ts.
      writes.push(
        insertUsageEvent(tx, {
          ...(input.analytics ?? {}),
          event_id: crypto.randomUUID(),
          request_id: reservation.request_id,
          reservation_id: reservation.id,
          account_id: reservation.account_id,
          provider: reservation.provider,
          provider_request_id: providerRequestId,
          estimated_cost_usd: Usd.parse(reservation.estimated_cost_usd).toString(),
          billed_cost_usd: actual.toString(),
          unfunded_cost_usd: unfunded.toString(),
          usage_source: input.usageSource,
          occurred_at: now.toISOString(),
        }),
      );

      const results = await Promise.all(writes);
      return toReservation(returnedRow(results[updateIndex], "finalized"));
    });
  }

  /** Returns every held amount to its counter. Repeating is a no-op. */
  async release(requestId: string): Promise<Reservation> {
    return this.sql.begin(async (tx) => {
      await lockReservationAccount(tx, requestId);
      const reservation = await requireReservation(tx, requestId);
      if (transition(requestId, "release", reservation.state) === "replay") {
        return toReservation(reservation);
      }

      const results = await Promise.all([
        ...releaseAllHolds(tx, reservation.id),
        tx`
          UPDATE billing_reservations
          SET
            state = 'released',
            reconciliation_reason = NULL,
            updated_at = now()
          WHERE id = ${reservation.id}::uuid
          RETURNING ${reservationColumns(tx)}
        `,
      ]);
      return toReservation(returnedRow(results.at(-1), "released"));
    });
  }

  /**
   * Keeps the hold in place for the reconciler: the provider may have
   * charged, but did not say how much. Holds are left untouched.
   */
  async markPendingReconciliation(
    requestId: string,
    reason: string,
    providerRequestId?: string,
  ): Promise<Reservation> {
    return this.sql.begin(async (tx) => {
      await lockReservationAccount(tx, requestId);
      const reservation = await requireReservation(tx, requestId);
      transition(requestId, "markPendingReconciliation", reservation.state);

      const rows = await tx`
        UPDATE billing_reservations
        SET
          state = 'pending_reconciliation',
          provider_request_id = COALESCE(
            ${providerRequestId ?? null},
            provider_request_id
          ),
          reconciliation_reason = ${reason},
          updated_at = now()
        WHERE id = ${reservation.id}::uuid
        RETURNING ${reservationColumns(tx)}
      `;
      return toReservation(returnedRow(rows, "pending"));
    });
  }
}

/** A retried reserve must describe the same request as the original. */
function assertSameReservation(existing: ReservationRow, input: ReserveInput) {
  const conflict = (detail: string) =>
    new ReservationConflictError(input.requestId, detail);
  if (existing.account_id !== input.accountId) throw conflict("account differs");
  if (existing.provider !== input.provider) throw conflict("provider differs");
  if (!Usd.parse(existing.estimated_cost_usd).equals(input.estimatedCostUsd)) {
    throw conflict("estimated cost differs");
  }
}

const insertUsageEvent = (tx: Tx, event: Record<string, JsonValue>) => tx`
  INSERT INTO request_event_outbox (payload)
  VALUES (${tx.json(event)}::jsonb)
`;
