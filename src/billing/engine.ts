import type postgres from "postgres";

import {
  BillingAccountNotFoundError,
  InsufficientFundsError,
  InvalidReservationStateError,
  LimitExceededError,
  ReservationConflictError,
  ReservationNotFoundError,
} from "./errors";
import { Usd } from "./money";

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
  expiresAt?: Date;
};

export type FinalizeInput = {
  requestId: string;
  actualCostUsd: Usd;
  usageSource: UsageSource;
  providerRequestId?: string;
  analytics?: Record<string, JsonValue>;
};

type ReservationRow = {
  id: string;
  request_id: string;
  account_id: string;
  provider: string;
  provider_request_id: string | null;
  state: ReservationState;
  estimated_cost_usd: string;
  actual_cost_usd: string | null;
  unfunded_cost_usd: string;
  expires_at: Date;
};

type LimitWindowRow = {
  id: string;
  policy_name: string;
  available_usd: string;
};

type AvailableSourceRow = {
  id: string;
  priority: number;
  available_usd: string;
  expires_at: Date | null;
};

type ExistingHoldRow = {
  id: string;
  priority: number;
  reserved_usd: string;
  expires_at: Date | null;
};

type FundingSource = {
  kind: "window" | "credit";
  id: string;
  priority: number;
  availableAtoms: bigint;
  expiresAt: Date | null;
};

type ExistingHold = FundingSource & {
  reservedAtoms: bigint;
};

/** A statement queued for one pipelined round trip. */
type Statement = postgres.PendingQuery<postgres.Row[]>;

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1_000;

const UNIQUE_VIOLATION = "23505";

const compareSources = (left: FundingSource, right: FundingSource) => {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  const leftExpiry = left.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightExpiry = right.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

  return left.id.localeCompare(right.id);
};

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

const minAtoms = (left: bigint, right: bigint) =>
  left < right ? left : right;

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
      const now = await this.lockAccount(tx, input.accountId);
      const expiresAt =
        input.expiresAt ?? new Date(now.getTime() + DEFAULT_RESERVATION_TTL_MS);
      if (expiresAt <= now) {
        throw new RangeError(
          "expiresAt must be later than the reservation time",
        );
      }

      // Materialization precedes the locking reads in issue order, so the
      // current windows exist by the time they are locked.
      const [existingRows, , , limits, windowRows, creditRows] =
        await Promise.all([
          this.selectReservation(tx, input.requestId, true),
          this.materializeFundingWindows(tx, input.accountId, now),
          this.materializeLimitWindows(tx, input.accountId, now),
          this.lockLimitWindows(tx, input.accountId, now),
          this.lockAvailableWindows(tx, input.accountId, now),
          this.lockAvailableCredits(tx, input.accountId, now),
        ]);

      const existing = existingRows[0];
      if (existing) {
        this.assertMatchingReservation(existing, input);
        return toReservation(existing);
      }

      const estimateAtoms = input.estimatedCostUsd.toAtoms();
      for (const limit of limits) {
        if (Usd.parse(limit.available_usd).toAtoms() < estimateAtoms) {
          throw new LimitExceededError(limit.policy_name);
        }
      }

      const sources = this.toFundingSources(windowRows, creditRows);
      const allocations = this.allocate(estimateAtoms, sources);
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
      const { accountId, now } = await this.lockReservationAccount(
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
        this.selectReservation(tx, input.requestId, true),
        this.lockWindowHolds(tx, input.requestId),
        this.lockCreditHolds(tx, input.requestId),
        this.lockAvailableWindows(tx, accountId, now),
        this.lockAvailableCredits(tx, accountId, now),
        this.lockLimitHolds(tx, input.requestId),
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

      if (reservation.state === "released") {
        throw new InvalidReservationStateError(
          input.requestId,
          reservation.state,
          "finalize",
        );
      }

      const writes: Statement[] = [];
      let remainingAtoms = input.actualCostUsd.toAtoms();

      for (const hold of this.toExistingHolds(windowHoldRows, creditHoldRows)) {
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
        const additional = this.allocate(
          remainingAtoms,
          this.toFundingSources(windowRows, creditRows),
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
      const { now } = await this.lockReservationAccount(tx, requestId);
      const reservation = await this.requireReservation(tx, requestId, true);

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
      const { now } = await this.lockReservationAccount(tx, requestId);
      const reservation = await this.requireReservation(tx, requestId, true);

      if (reservation.state === "finalized" || reservation.state === "released") {
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

  /**
   * Takes the account's advisory lock, confirms the account exists, and
   * reads the transaction clock in one round trip. The lock is taken in the
   * FROM clause so it is held before the account row is read.
   */
  private async lockAccount(
    tx: TransactionSql,
    accountId: string,
  ): Promise<Date> {
    const [row] = await tx<{ now: Date; account_id: string | null }[]>`
      SELECT
        transaction_timestamp() AS now,
        (
          SELECT id
          FROM billing_accounts
          WHERE id = ${accountId}::uuid
        ) AS account_id
      FROM pg_advisory_xact_lock(hashtextextended(${accountId}, 0))
    `;
    if (!row) throw new Error("PostgreSQL did not return its transaction time");
    if (!row.account_id) throw new BillingAccountNotFoundError(accountId);
    return row.now;
  }

  /**
   * Resolves a reservation's account and takes that account's advisory lock
   * in one round trip. The reservation row itself is locked afterwards by
   * the caller, once the account lock orders it against reserves.
   */
  private async lockReservationAccount(
    tx: TransactionSql,
    requestId: string,
  ): Promise<{ accountId: string; now: Date }> {
    const [row] = await tx<{ account_id: string; now: Date }[]>`
      SELECT
        account_id,
        pg_advisory_xact_lock(hashtextextended(account_id::text, 0)),
        transaction_timestamp() AS now
      FROM billing_reservations
      WHERE request_id = ${requestId}::uuid
    `;
    if (!row) throw new ReservationNotFoundError(requestId);
    return { accountId: row.account_id, now: row.now };
  }

  private selectReservation(
    tx: TransactionSql,
    requestId: string,
    forUpdate: boolean,
  ) {
    return forUpdate
      ? tx<ReservationRow[]>`
          SELECT
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
          FROM billing_reservations
          WHERE request_id = ${requestId}::uuid
          FOR UPDATE
        `
      : tx<ReservationRow[]>`
          SELECT
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
          FROM billing_reservations
          WHERE request_id = ${requestId}::uuid
        `;
  }

  private async requireReservation(
    tx: TransactionSql,
    requestId: string,
    forUpdate: boolean,
  ) {
    const [reservation] = await this.selectReservation(
      tx,
      requestId,
      forUpdate,
    );
    if (!reservation) throw new ReservationNotFoundError(requestId);
    return reservation;
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

  private materializeFundingWindows(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ) {
    return tx`
      WITH policies AS (
        SELECT
          policy.*,
          date_trunc(
            policy.cadence,
            ${now}::timestamptz AT TIME ZONE policy.timezone
          ) AS local_start
        FROM billing_funding_policies AS policy
        WHERE
          policy.account_id = ${accountId}::uuid
          AND policy.enabled
          AND policy.effective_from <= ${now}
          AND (
            policy.effective_until IS NULL
            OR policy.effective_until > ${now}
          )
      ),
      windows AS (
        SELECT
          id AS policy_id,
          account_id,
          generation,
          local_start AT TIME ZONE timezone AS window_start,
          (
            local_start
            + CASE cadence
                WHEN 'day' THEN INTERVAL '1 day'
                WHEN 'week' THEN INTERVAL '1 week'
                WHEN 'month' THEN INTERVAL '1 month'
                WHEN 'year' THEN INTERVAL '1 year'
              END
          ) AT TIME ZONE timezone AS window_end,
          amount_usd
        FROM policies
      )
      INSERT INTO billing_funding_windows (
        policy_id,
        account_id,
        generation,
        window_start,
        window_end,
        granted_usd
      )
      SELECT
        policy_id,
        account_id,
        generation,
        window_start,
        window_end,
        amount_usd
      FROM windows
      ON CONFLICT (policy_id, generation, window_start) DO NOTHING
    `;
  }

  private materializeLimitWindows(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ) {
    return tx`
      WITH policies AS (
        SELECT
          policy.*,
          CASE
            WHEN cadence = 'lifetime' THEN effective_from
            ELSE date_trunc(
              policy.cadence,
              ${now}::timestamptz AT TIME ZONE policy.timezone
            ) AT TIME ZONE policy.timezone
          END AS window_start,
          CASE
            WHEN cadence = 'lifetime' THEN COALESCE(
              effective_until,
              '9999-12-31 23:59:59+00'::timestamptz
            )
            ELSE (
              date_trunc(
                policy.cadence,
                ${now}::timestamptz AT TIME ZONE policy.timezone
              )
              + CASE cadence
                  WHEN 'day' THEN INTERVAL '1 day'
                  WHEN 'week' THEN INTERVAL '1 week'
                  WHEN 'month' THEN INTERVAL '1 month'
                  WHEN 'year' THEN INTERVAL '1 year'
                END
            ) AT TIME ZONE policy.timezone
          END AS window_end
        FROM billing_limit_policies AS policy
        WHERE
          policy.account_id = ${accountId}::uuid
          AND policy.enabled
          AND policy.effective_from <= ${now}
          AND (
            policy.effective_until IS NULL
            OR policy.effective_until > ${now}
          )
      )
      INSERT INTO billing_limit_windows (
        policy_id,
        account_id,
        generation,
        window_start,
        window_end,
        limit_usd
      )
      SELECT
        id,
        account_id,
        generation,
        window_start,
        window_end,
        limit_usd
      FROM policies
      ON CONFLICT (policy_id, generation, window_start) DO NOTHING
    `;
  }

  private lockLimitWindows(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ) {
    return tx<LimitWindowRow[]>`
      SELECT
        limit_window.id,
        policy.name AS policy_name,
        (
          limit_window.limit_usd
          - limit_window.reserved_usd
          - limit_window.committed_usd
        )::text AS available_usd
      FROM billing_limit_windows AS limit_window
      INNER JOIN billing_limit_policies AS policy
        ON policy.id = limit_window.policy_id
      WHERE
        limit_window.account_id = ${accountId}::uuid
        AND limit_window.generation = policy.generation
        AND limit_window.superseded_at IS NULL
        AND limit_window.window_start <= ${now}
        AND limit_window.window_end > ${now}
        AND policy.enabled
      ORDER BY policy.id, limit_window.id
      FOR UPDATE OF limit_window
    `;
  }

  private lockAvailableWindows(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ) {
    return tx<AvailableSourceRow[]>`
      SELECT
        funding_window.id,
        policy.priority,
        (
          funding_window.granted_usd
          - funding_window.reserved_usd
          - funding_window.committed_usd
        )::text AS available_usd,
        funding_window.window_end AS expires_at
      FROM billing_funding_windows AS funding_window
      INNER JOIN billing_funding_policies AS policy
        ON policy.id = funding_window.policy_id
      WHERE
        funding_window.account_id = ${accountId}::uuid
        AND funding_window.generation = policy.generation
        AND funding_window.superseded_at IS NULL
        AND funding_window.window_start <= ${now}
        AND funding_window.window_end > ${now}
        AND policy.enabled
      ORDER BY policy.priority, funding_window.window_end, funding_window.id
      FOR UPDATE OF funding_window
    `;
  }

  private lockAvailableCredits(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ) {
    return tx<AvailableSourceRow[]>`
      SELECT
        id,
        priority,
        (granted_usd - reserved_usd - committed_usd)::text AS available_usd,
        expires_at
      FROM billing_credit_grants
      WHERE
        account_id = ${accountId}::uuid
        AND valid_from <= ${now}
        AND (expires_at IS NULL OR expires_at > ${now})
      ORDER BY priority, expires_at NULLS LAST, id
      FOR UPDATE
    `;
  }

  private toFundingSources(
    windows: AvailableSourceRow[],
    credits: AvailableSourceRow[],
  ): FundingSource[] {
    return [
      ...windows.map((row) => ({
        kind: "window" as const,
        id: row.id,
        priority: row.priority,
        availableAtoms: Usd.parse(row.available_usd).toAtoms(),
        expiresAt: row.expires_at,
      })),
      ...credits.map((row) => ({
        kind: "credit" as const,
        id: row.id,
        priority: row.priority,
        availableAtoms: Usd.parse(row.available_usd).toAtoms(),
        expiresAt: row.expires_at,
      })),
    ].sort(compareSources);
  }

  private allocate(amountAtoms: bigint, sources: FundingSource[]) {
    let remainingAtoms = amountAtoms;
    const items: {
      source: FundingSource;
      amountAtoms: bigint;
    }[] = [];

    for (const source of sources) {
      if (remainingAtoms === 0n) break;
      const amount = minAtoms(remainingAtoms, source.availableAtoms);
      if (amount <= 0n) continue;
      items.push({ source, amountAtoms: amount });
      remainingAtoms -= amount;
    }

    return { items, remainingAtoms };
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

  /** Hold rows are keyed by request id so they need no prior lookup. */
  private lockWindowHolds(tx: TransactionSql, requestId: string) {
    return tx<ExistingHoldRow[]>`
      SELECT
        funding_window.id,
        policy.priority,
        hold.reserved_usd::text,
        funding_window.window_end AS expires_at
      FROM billing_reservation_funding_holds AS hold
      INNER JOIN billing_funding_windows AS funding_window
        ON funding_window.id = hold.funding_window_id
      INNER JOIN billing_funding_policies AS policy
        ON policy.id = funding_window.policy_id
      WHERE hold.reservation_id = (
        SELECT id FROM billing_reservations WHERE request_id = ${requestId}::uuid
      )
      ORDER BY policy.priority, funding_window.window_end, funding_window.id
      FOR UPDATE OF hold, funding_window
    `;
  }

  private lockCreditHolds(tx: TransactionSql, requestId: string) {
    return tx<ExistingHoldRow[]>`
      SELECT
        credit.id,
        credit.priority,
        hold.reserved_usd::text,
        credit.expires_at
      FROM billing_reservation_credit_holds AS hold
      INNER JOIN billing_credit_grants AS credit
        ON credit.id = hold.credit_grant_id
      WHERE hold.reservation_id = (
        SELECT id FROM billing_reservations WHERE request_id = ${requestId}::uuid
      )
      ORDER BY credit.priority, credit.expires_at NULLS LAST, credit.id
      FOR UPDATE OF hold, credit
    `;
  }

  private lockLimitHolds(tx: TransactionSql, requestId: string) {
    return tx<{ id: string; reserved_usd: string }[]>`
      SELECT
        limit_window.id,
        hold.reserved_usd::text
      FROM billing_reservation_limit_holds AS hold
      INNER JOIN billing_limit_windows AS limit_window
        ON limit_window.id = hold.limit_window_id
      WHERE hold.reservation_id = (
        SELECT id FROM billing_reservations WHERE request_id = ${requestId}::uuid
      )
      ORDER BY limit_window.id
      FOR UPDATE OF hold, limit_window
    `;
  }

  private toExistingHolds(
    windows: ExistingHoldRow[],
    credits: ExistingHoldRow[],
  ): ExistingHold[] {
    return [
      ...windows.map((row) => ({
        kind: "window" as const,
        id: row.id,
        priority: row.priority,
        availableAtoms: 0n,
        reservedAtoms: Usd.parse(row.reserved_usd).toAtoms(),
        expiresAt: row.expires_at,
      })),
      ...credits.map((row) => ({
        kind: "credit" as const,
        id: row.id,
        priority: row.priority,
        availableAtoms: 0n,
        reservedAtoms: Usd.parse(row.reserved_usd).toAtoms(),
        expiresAt: row.expires_at,
      })),
    ].sort(compareSources);
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
