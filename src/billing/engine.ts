import type postgres from "postgres";

import {
  allocate,
  type ExistingHold,
  type FundingSource,
  minAtoms,
  toExistingHolds,
  toFundingSources,
} from "./allocation";
import {
  InsufficientFundsError,
  InvalidReservationStateError,
  LimitExceededError,
  ReservationConflictError,
  ReservationNotFoundError,
} from "./errors";
import {
  lockAccount,
  lockAvailableCredits,
  lockAvailableWindows,
  lockCreditHolds,
  lockLimitHolds,
  lockLimitWindows,
  lockReservationAccount,
  lockWindowHolds,
  type LimitWindowRow,
  requireReservation,
  type ReservationRow,
  selectReservation,
  type Statement,
} from "./locks";
import { Usd } from "./money";
import {
  materializeFundingWindows,
  materializeLimitWindows,
} from "./windows";

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;

type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ReservationState =
  | "reserved"
  | "pending_reconciliation"
  | "finalized"
  | "released";

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

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === UNIQUE_VIOLATION;

/**
 * Reservation engine over PostgreSQL.
 *
 * Every operation serializes on a per-account advisory lock, so the work
 * done while holding that lock bounds the throughput of a busy account. Each
 * operation is therefore shaped as three round trips: one statement that
 * takes the lock and reads the clock, one pipelined batch of reads, and one
 * pipelined batch of writes. Statements issued together through
 * `Promise.all` on the transaction connection are sent without waiting for
 * earlier replies and execute in issue order.
 */
export class BillingEngine {
  constructor(private readonly sql: Sql) {}

  async reserve(input: ReserveInput): Promise<Reservation> {
    if (input.estimatedCostUsd.isNegative()) {
      throw new RangeError("estimatedCostUsd must not be negative");
    }

    return this.sql.begin(async (tx) => {
      // Concurrent reserves for one request id share an account, so the
      // account lock also serializes idempotent retries.
      const now = await lockAccount(tx, input.accountId);
      const ttlMs = input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("ttlMs must be a positive number of milliseconds");
      }
      const expiresAt = new Date(now.getTime() + ttlMs);

      // Materialization precedes the locking reads in issue order, so the
      // current windows exist by the time they are locked.
      const [existingRows, , , limits, windowRows, creditRows] =
        await Promise.all([
          selectReservation(tx, input.requestId, true),
          materializeFundingWindows(tx, input.accountId, now),
          materializeLimitWindows(tx, input.accountId, now),
          lockLimitWindows(tx, input.accountId, now),
          lockAvailableWindows(tx, input.accountId, now),
          lockAvailableCredits(tx, input.accountId, now),
        ]);

      const existing = existingRows[0];
      if (existing) {
        this.assertMatchingReservation(existing, input);
        // Only a live hold can be handed back to a retrying caller. A
        // released or settled reservation holds no funds, so dispatching
        // against it would run the provider call unbilled.
        if (existing.state !== "reserved") {
          throw new InvalidReservationStateError(
            input.requestId,
            existing.state,
            "reserve",
          );
        }
        return toReservation(existing);
      }

      const estimateAtoms = input.estimatedCostUsd.toAtoms();
      for (const limit of limits) {
        if (Usd.parse(limit.available_usd).toAtoms() < estimateAtoms) {
          throw new LimitExceededError(limit.policy_name);
        }
      }

      const sources = toFundingSources(windowRows, creditRows);
      const allocations = allocate(estimateAtoms, sources);
      if (allocations.remainingAtoms > 0n) {
        throw new InsufficientFundsError();
      }

      // The id is generated here so the hold rows can be written in the
      // same round trip as the reservation itself.
      const reservationId = crypto.randomUUID();
      const estimate = input.estimatedCostUsd.toString();
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
            ${estimate}::numeric,
            ${expiresAt}
          )
          RETURNING
            id,
            request_id,
            account_id,
            provider,
            provider_request_id,
            state,
            estimated_cost_usd::text,
            actual_cost_usd::text,
            unfunded_cost_usd::text,
            expires_at
        `,
      ];

      for (const allocation of allocations.items) {
        writes.push(
          ...this.reserveFunding(
            tx,
            reservationId,
            allocation.source,
            allocation.amountAtoms,
          ),
        );
      }

      for (const limit of limits) {
        writes.push(
          tx`
            UPDATE billing_limit_windows
            SET
              reserved_usd = reserved_usd + ${estimate}::numeric,
              updated_at = ${now}
            WHERE id = ${limit.id}::uuid
          `,
          tx`
            INSERT INTO billing_reservation_limit_holds (
              reservation_id,
              limit_window_id,
              reserved_usd
            )
            VALUES (
              ${reservationId}::uuid,
              ${limit.id}::uuid,
              ${estimate}::numeric
            )
          `,
        );
      }

      let created: ReservationRow | undefined;
      try {
        const [rows] = await Promise.all(writes);
        created = (rows as unknown as ReservationRow[])[0];
      } catch (error) {
        // Only a different account reserving the same request id can slip
        // past the account lock and collide on the request id.
        if (isUniqueViolation(error)) {
          throw new ReservationConflictError(
            input.requestId,
            "account differs",
          );
        }
        throw error;
      }

      if (!created) {
        throw new Error("PostgreSQL did not return the created reservation");
      }
      return toReservation(created);
    });
  }

  async finalize(input: FinalizeInput): Promise<Reservation> {
    if (input.actualCostUsd.isNegative()) {
      throw new RangeError("actualCostUsd must not be negative");
    }

    return this.sql.begin(async (tx) => {
      const { accountId, now } = await lockReservationAccount(
        tx,
        input.requestId,
      );

      // Available funding is read up front so an actual cost above the
      // estimate needs no further round trip.
      const [
        reservationRows,
        windowHoldRows,
        creditHoldRows,
        windowRows,
        creditRows,
        limitHolds,
      ] = await Promise.all([
        selectReservation(tx, input.requestId, true),
        lockWindowHolds(tx, input.requestId),
        lockCreditHolds(tx, input.requestId),
        lockAvailableWindows(tx, accountId, now),
        lockAvailableCredits(tx, accountId, now),
        lockLimitHolds(tx, input.requestId),
      ]);

      const reservation = reservationRows[0];
      if (!reservation) throw new ReservationNotFoundError(input.requestId);

      if (reservation.state === "finalized") {
        if (
          reservation.actual_cost_usd === null ||
          Usd.parse(reservation.actual_cost_usd).toAtoms() !==
            input.actualCostUsd.toAtoms()
        ) {
          throw new ReservationConflictError(
            input.requestId,
            "the actual cost differs from the finalized charge",
          );
        }
        return toReservation(reservation);
      }

      // A reservation whose holds were released (the expiry sweeper beat a
      // long-running request to it, possibly via pending_reconciliation)
      // holds nothing, but the provider still charged for the work. It is
      // finalized like a reservation with no holds: funded from what the
      // account has available now, the rest booked as unfunded, and counted
      // against the limit windows current at finalization.
      let lateLimitWindows: LimitWindowRow[] = [];
      if (limitHolds.length === 0 && input.actualCostUsd.toAtoms() > 0n) {
        await materializeLimitWindows(tx, accountId, now);
        lateLimitWindows = await lockLimitWindows(tx, accountId, now);
      }

      const writes: Statement[] = [];
      let remainingAtoms = input.actualCostUsd.toAtoms();

      for (const hold of toExistingHolds(windowHoldRows, creditHoldRows)) {
        const committedAtoms = minAtoms(remainingAtoms, hold.reservedAtoms);
        writes.push(
          ...this.commitExistingHold(
            tx,
            reservation.id,
            hold,
            committedAtoms,
            now,
          ),
        );
        remainingAtoms -= committedAtoms;
      }

      if (remainingAtoms > 0n) {
        const additional = allocate(
          remainingAtoms,
          toFundingSources(windowRows, creditRows),
        );
        for (const allocation of additional.items) {
          writes.push(
            ...this.commitAdditionalFunding(
              tx,
              reservation.id,
              allocation.source,
              allocation.amountAtoms,
              now,
            ),
          );
        }
        remainingAtoms = additional.remainingAtoms;
      }

      writes.push(
        ...this.finalizeLimitHolds(
          tx,
          reservation.id,
          limitHolds,
          input.actualCostUsd,
          now,
        ),
        ...this.commitLateLimitUsage(
          tx,
          reservation.id,
          lateLimitWindows,
          input.actualCostUsd,
          now,
        ),
      );

      const actualCost = input.actualCostUsd.toString();
      const providerRequestId =
        input.providerRequestId ?? reservation.provider_request_id;

      if (input.actualCostUsd.toAtoms() > 0n) {
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
            ${actualCost}::numeric,
            ${tx.json({
              provider: reservation.provider,
              provider_request_id: providerRequestId,
              usage_source: input.usageSource,
            })},
            ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `);
      }

      const unfundedCost = Usd.fromAtoms(remainingAtoms);
      const updateIndex = writes.length;
      writes.push(tx`
        UPDATE billing_reservations
        SET
          state = 'finalized',
          provider_request_id = ${providerRequestId},
          actual_cost_usd = ${actualCost}::numeric,
          unfunded_cost_usd = ${unfundedCost.toString()}::numeric,
          usage_source = ${input.usageSource},
          reconciliation_reason = NULL,
          finalized_at = ${now},
          updated_at = ${now}
        WHERE id = ${reservation.id}::uuid
        RETURNING
          id,
          request_id,
          account_id,
          provider,
          provider_request_id,
          state,
          estimated_cost_usd::text,
          actual_cost_usd::text,
          unfunded_cost_usd::text,
          expires_at
      `);

      const event: Record<string, JsonValue> = {
        ...(input.analytics ?? {}),
        event_id: crypto.randomUUID(),
        request_id: reservation.request_id,
        reservation_id: reservation.id,
        account_id: reservation.account_id,
        provider: reservation.provider,
        provider_request_id: providerRequestId,
        estimated_cost_usd: Usd.parse(reservation.estimated_cost_usd).toString(),
        billed_cost_usd: input.actualCostUsd.toString(),
        unfunded_cost_usd: unfundedCost.toString(),
        usage_source: input.usageSource,
        occurred_at: now.toISOString(),
      };

      // Same transaction as the ledger and reservation update, so the
      // event exists if and only if the finalization committed. The
      // analytics worker drains the outbox to ClickHouse in batches; see
      // src/analytics/request-events.ts.
      writes.push(tx`
        INSERT INTO request_event_outbox (payload)
        VALUES (${tx.json(event)}::jsonb)
      `);

      const results = await Promise.all(writes);
      const updated = (results[updateIndex] as unknown as ReservationRow[])[0];
      if (!updated) {
        throw new Error("PostgreSQL did not return the finalized reservation");
      }
      return toReservation(updated);
    });
  }

  async release(requestId: string): Promise<Reservation> {
    return this.sql.begin(async (tx) => {
      const { now } = await lockReservationAccount(tx, requestId);
      const reservation = await requireReservation(tx, requestId, true);

      if (reservation.state === "released") {
        return toReservation(reservation);
      }
      if (reservation.state === "finalized") {
        throw new InvalidReservationStateError(
          requestId,
          reservation.state,
          "release",
        );
      }

      const [, , , , , , rows] = await Promise.all([
        tx`
          UPDATE billing_funding_windows AS funding_window
          SET
            reserved_usd = funding_window.reserved_usd - hold.reserved_usd,
            updated_at = ${now}
          FROM billing_reservation_funding_holds AS hold
          WHERE
            hold.reservation_id = ${reservation.id}::uuid
            AND hold.funding_window_id = funding_window.id
        `,
        tx`
          UPDATE billing_credit_grants AS credit
          SET
            reserved_usd = credit.reserved_usd - hold.reserved_usd,
            updated_at = ${now}
          FROM billing_reservation_credit_holds AS hold
          WHERE
            hold.reservation_id = ${reservation.id}::uuid
            AND hold.credit_grant_id = credit.id
        `,
        tx`
          UPDATE billing_limit_windows AS limit_window
          SET
            reserved_usd = limit_window.reserved_usd - hold.reserved_usd,
            updated_at = ${now}
          FROM billing_reservation_limit_holds AS hold
          WHERE
            hold.reservation_id = ${reservation.id}::uuid
            AND hold.limit_window_id = limit_window.id
        `,
        tx`
          DELETE FROM billing_reservation_funding_holds
          WHERE reservation_id = ${reservation.id}::uuid
        `,
        tx`
          DELETE FROM billing_reservation_credit_holds
          WHERE reservation_id = ${reservation.id}::uuid
        `,
        tx`
          DELETE FROM billing_reservation_limit_holds
          WHERE reservation_id = ${reservation.id}::uuid
        `,
        tx<ReservationRow[]>`
          UPDATE billing_reservations
          SET
            state = 'released',
            reconciliation_reason = NULL,
            updated_at = ${now}
          WHERE id = ${reservation.id}::uuid
          RETURNING
            id,
            request_id,
            account_id,
            provider,
            provider_request_id,
            state,
            estimated_cost_usd::text,
            actual_cost_usd::text,
            unfunded_cost_usd::text,
            expires_at
        `,
      ]);

      const updated = rows[0];
      if (!updated) {
        throw new Error("PostgreSQL did not return the released reservation");
      }
      return toReservation(updated);
    });
  }

  async markPendingReconciliation(
    requestId: string,
    reason: string,
    providerRequestId?: string,
  ): Promise<Reservation> {
    return this.sql.begin(async (tx) => {
      const { now } = await lockReservationAccount(tx, requestId);
      const reservation = await requireReservation(tx, requestId, true);

      // A released reservation may still be marked pending: the provider
      // may have charged for it, and finalize accepts released rows.
      if (reservation.state === "finalized") {
        throw new InvalidReservationStateError(
          requestId,
          reservation.state,
          "mark pending reconciliation",
        );
      }

      const [updated] = await tx<ReservationRow[]>`
        UPDATE billing_reservations
        SET
          state = 'pending_reconciliation',
          provider_request_id = COALESCE(
            ${providerRequestId ?? null},
            provider_request_id
          ),
          reconciliation_reason = ${reason},
          updated_at = ${now}
        WHERE id = ${reservation.id}::uuid
        RETURNING
          id,
          request_id,
          account_id,
          provider,
          provider_request_id,
          state,
          estimated_cost_usd::text,
          actual_cost_usd::text,
          unfunded_cost_usd::text,
          expires_at
      `;

      if (!updated) {
        throw new Error("PostgreSQL did not return the pending reservation");
      }
      return toReservation(updated);
    });
  }

  private assertMatchingReservation(
    existing: ReservationRow,
    input: ReserveInput,
  ) {
    if (existing.account_id !== input.accountId) {
      throw new ReservationConflictError(input.requestId, "account differs");
    }
    if (existing.provider !== input.provider) {
      throw new ReservationConflictError(input.requestId, "provider differs");
    }
    if (
      Usd.parse(existing.estimated_cost_usd).toAtoms() !==
      input.estimatedCostUsd.toAtoms()
    ) {
      throw new ReservationConflictError(
        input.requestId,
        "estimated cost differs",
      );
    }
  }

  private reserveFunding(
    tx: TransactionSql,
    reservationId: string,
    source: FundingSource,
    amountAtoms: bigint,
  ): Statement[] {
    const amount = Usd.fromAtoms(amountAtoms).toString();
    if (source.kind === "window") {
      return [
        tx`
          UPDATE billing_funding_windows
          SET
            reserved_usd = reserved_usd + ${amount}::numeric,
            updated_at = now()
          WHERE id = ${source.id}::uuid
        `,
        tx`
          INSERT INTO billing_reservation_funding_holds (
            reservation_id,
            funding_window_id,
            reserved_usd
          )
          VALUES (
            ${reservationId}::uuid,
            ${source.id}::uuid,
            ${amount}::numeric
          )
        `,
      ];
    }

    return [
      tx`
        UPDATE billing_credit_grants
        SET
          reserved_usd = reserved_usd + ${amount}::numeric,
          updated_at = now()
        WHERE id = ${source.id}::uuid
      `,
      tx`
        INSERT INTO billing_reservation_credit_holds (
          reservation_id,
          credit_grant_id,
          reserved_usd
        )
        VALUES (
          ${reservationId}::uuid,
          ${source.id}::uuid,
          ${amount}::numeric
        )
      `,
    ];
  }

  private commitExistingHold(
    tx: TransactionSql,
    reservationId: string,
    hold: ExistingHold,
    committedAtoms: bigint,
    now: Date,
  ): Statement[] {
    const reserved = Usd.fromAtoms(hold.reservedAtoms).toString();
    const committed = Usd.fromAtoms(committedAtoms).toString();

    if (hold.kind === "window") {
      return [
        tx`
          UPDATE billing_funding_windows
          SET
            reserved_usd = reserved_usd - ${reserved}::numeric,
            committed_usd = committed_usd + ${committed}::numeric,
            updated_at = ${now}
          WHERE id = ${hold.id}::uuid
        `,
        committedAtoms === 0n
          ? tx`
              DELETE FROM billing_reservation_funding_holds
              WHERE
                reservation_id = ${reservationId}::uuid
                AND funding_window_id = ${hold.id}::uuid
            `
          : tx`
              UPDATE billing_reservation_funding_holds
              SET
                reserved_usd = 0,
                committed_usd = ${committed}::numeric
              WHERE
                reservation_id = ${reservationId}::uuid
                AND funding_window_id = ${hold.id}::uuid
            `,
      ];
    }

    return [
      tx`
        UPDATE billing_credit_grants
        SET
          reserved_usd = reserved_usd - ${reserved}::numeric,
          committed_usd = committed_usd + ${committed}::numeric,
          updated_at = ${now}
        WHERE id = ${hold.id}::uuid
      `,
      committedAtoms === 0n
        ? tx`
            DELETE FROM billing_reservation_credit_holds
            WHERE
              reservation_id = ${reservationId}::uuid
              AND credit_grant_id = ${hold.id}::uuid
          `
        : tx`
            UPDATE billing_reservation_credit_holds
            SET
              reserved_usd = 0,
              committed_usd = ${committed}::numeric
            WHERE
              reservation_id = ${reservationId}::uuid
              AND credit_grant_id = ${hold.id}::uuid
          `,
    ];
  }

  private commitAdditionalFunding(
    tx: TransactionSql,
    reservationId: string,
    source: FundingSource,
    amountAtoms: bigint,
    now: Date,
  ): Statement[] {
    const amount = Usd.fromAtoms(amountAtoms).toString();
    if (source.kind === "window") {
      return [
        tx`
          UPDATE billing_funding_windows
          SET
            committed_usd = committed_usd + ${amount}::numeric,
            updated_at = ${now}
          WHERE id = ${source.id}::uuid
        `,
        tx`
          INSERT INTO billing_reservation_funding_holds (
            reservation_id,
            funding_window_id,
            committed_usd
          )
          VALUES (
            ${reservationId}::uuid,
            ${source.id}::uuid,
            ${amount}::numeric
          )
          ON CONFLICT (reservation_id, funding_window_id)
          DO UPDATE SET
            committed_usd =
              billing_reservation_funding_holds.committed_usd
              + EXCLUDED.committed_usd
        `,
      ];
    }

    return [
      tx`
        UPDATE billing_credit_grants
        SET
          committed_usd = committed_usd + ${amount}::numeric,
          updated_at = ${now}
        WHERE id = ${source.id}::uuid
      `,
      tx`
        INSERT INTO billing_reservation_credit_holds (
          reservation_id,
          credit_grant_id,
          committed_usd
        )
        VALUES (
          ${reservationId}::uuid,
          ${source.id}::uuid,
          ${amount}::numeric
        )
        ON CONFLICT (reservation_id, credit_grant_id)
        DO UPDATE SET
          committed_usd =
            billing_reservation_credit_holds.committed_usd
            + EXCLUDED.committed_usd
      `,
    ];
  }

  /**
   * Counts a late charge (a reservation finalized after its holds were
   * released) against the limit windows current at finalization time.
   */
  private commitLateLimitUsage(
    tx: TransactionSql,
    reservationId: string,
    windows: LimitWindowRow[],
    actualCost: Usd,
    now: Date,
  ): Statement[] {
    const actual = actualCost.toString();
    return windows.flatMap((window) => [
      tx`
        UPDATE billing_limit_windows
        SET
          committed_usd = committed_usd + ${actual}::numeric,
          updated_at = ${now}
        WHERE id = ${window.id}::uuid
      `,
      tx`
        INSERT INTO billing_reservation_limit_holds (
          reservation_id,
          limit_window_id,
          reserved_usd,
          committed_usd
        )
        VALUES (
          ${reservationId}::uuid,
          ${window.id}::uuid,
          0,
          ${actual}::numeric
        )
      `,
    ]);
  }

  private finalizeLimitHolds(
    tx: TransactionSql,
    reservationId: string,
    holds: { id: string; reserved_usd: string }[],
    actualCost: Usd,
    now: Date,
  ): Statement[] {
    const actual = actualCost.toString();
    return holds.flatMap((hold) => [
      tx`
        UPDATE billing_limit_windows
        SET
          reserved_usd = reserved_usd - ${hold.reserved_usd}::numeric,
          committed_usd = committed_usd + ${actual}::numeric,
          updated_at = ${now}
        WHERE id = ${hold.id}::uuid
      `,
      actualCost.toAtoms() === 0n
        ? tx`
            DELETE FROM billing_reservation_limit_holds
            WHERE
              reservation_id = ${reservationId}::uuid
              AND limit_window_id = ${hold.id}::uuid
          `
        : tx`
            UPDATE billing_reservation_limit_holds
            SET
              reserved_usd = 0,
              committed_usd = ${actual}::numeric
            WHERE
              reservation_id = ${reservationId}::uuid
              AND limit_window_id = ${hold.id}::uuid
          `,
    ]);
  }
}
