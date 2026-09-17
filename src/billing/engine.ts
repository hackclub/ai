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

/** Task identifier consumed by src/analytics/request-event-task.ts. */
export const REQUEST_EVENT_TASK = "analytics.request_event";

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

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1_000;

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

export class BillingEngine {
  constructor(private readonly sql: Sql) {}

  async reserve(input: ReserveInput): Promise<Reservation> {
    if (input.estimatedCostUsd.isNegative()) {
      throw new RangeError("estimatedCostUsd must not be negative");
    }

    return this.sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`reservation:${input.requestId}`}, 0)
        )
      `;
      await this.lockAccount(tx, input.accountId);

      const now = await this.databaseNow(tx);
      const expiresAt =
        input.expiresAt ?? new Date(now.getTime() + DEFAULT_RESERVATION_TTL_MS);
      if (expiresAt <= now) {
        throw new RangeError(
          "expiresAt must be later than the reservation time",
        );
      }

      const existing = await this.findReservation(tx, input.requestId, true);
      if (existing) {
        this.assertMatchingReservation(existing, input);
        return toReservation(existing);
      }

      await this.materializeFundingWindows(tx, input.accountId, now);
      await this.materializeLimitWindows(tx, input.accountId, now);

      const estimateAtoms = input.estimatedCostUsd.toAtoms();
      const limits = await this.lockLimitWindows(tx, input.accountId, now);
      for (const limit of limits) {
        if (Usd.parse(limit.available_usd).toAtoms() < estimateAtoms) {
          throw new LimitExceededError(limit.policy_name);
        }
      }

      const sources = await this.lockAvailableFunding(
        tx,
        input.accountId,
        now,
      );
      const allocations = this.allocate(estimateAtoms, sources);
      if (allocations.remainingAtoms > 0n) {
        throw new InsufficientFundsError();
      }

      const [created] = await tx<ReservationRow[]>`
        INSERT INTO billing_reservations (
          request_id,
          account_id,
          provider,
          estimated_cost_usd,
          expires_at
        )
        VALUES (
          ${input.requestId}::uuid,
          ${input.accountId}::uuid,
          ${input.provider},
          ${input.estimatedCostUsd.toString()}::numeric,
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
      `;

      if (!created) {
        throw new Error("PostgreSQL did not return the created reservation");
      }

      for (const allocation of allocations.items) {
        await this.reserveFunding(
          tx,
          created.id,
          allocation.source,
          allocation.amountAtoms,
        );
      }

      for (const limit of limits) {
        await tx`
          UPDATE billing_limit_windows
          SET
            reserved_usd = reserved_usd + ${input.estimatedCostUsd.toString()}::numeric,
            updated_at = ${now}
          WHERE id = ${limit.id}::uuid
        `;

        await tx`
          INSERT INTO billing_reservation_limit_holds (
            reservation_id,
            limit_window_id,
            reserved_usd
          )
          VALUES (
            ${created.id}::uuid,
            ${limit.id}::uuid,
            ${input.estimatedCostUsd.toString()}::numeric
          )
        `;
      }

      return toReservation(created);
    });
  }

  async finalize(input: FinalizeInput): Promise<Reservation> {
    if (input.actualCostUsd.isNegative()) {
      throw new RangeError("actualCostUsd must not be negative");
    }

    const accountId = await this.findAccountId(input.requestId);
    return this.sql.begin(async (tx) => {
      await this.lockAccount(tx, accountId);
      const now = await this.databaseNow(tx);
      const reservation = await this.requireReservation(
        tx,
        input.requestId,
        true,
      );

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

      let remainingAtoms = input.actualCostUsd.toAtoms();
      const existingHolds = await this.lockExistingFundingHolds(
        tx,
        reservation.id,
      );

      for (const hold of existingHolds) {
        const committedAtoms = minAtoms(remainingAtoms, hold.reservedAtoms);
        await this.commitExistingHold(
          tx,
          reservation.id,
          hold,
          committedAtoms,
          now,
        );
        remainingAtoms -= committedAtoms;
      }

      if (remainingAtoms > 0n) {
        const additionalSources = await this.lockAvailableFunding(
          tx,
          reservation.account_id,
          now,
        );
        const additional = this.allocate(remainingAtoms, additionalSources);

        for (const allocation of additional.items) {
          await this.commitAdditionalFunding(
            tx,
            reservation.id,
            allocation.source,
            allocation.amountAtoms,
            now,
          );
        }
        remainingAtoms = additional.remainingAtoms;
      }

      await this.finalizeLimitHolds(
        tx,
        reservation.id,
        input.actualCostUsd,
        now,
      );

      if (input.actualCostUsd.toAtoms() > 0n) {
        await tx`
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
            ${input.actualCostUsd.toString()}::numeric,
            ${tx.json({
              provider: reservation.provider,
              provider_request_id:
                input.providerRequestId ?? reservation.provider_request_id,
              usage_source: input.usageSource,
            })},
            ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
      }

      const unfundedCost = Usd.fromAtoms(remainingAtoms);
      const [updated] = await tx<ReservationRow[]>`
        UPDATE billing_reservations
        SET
          state = 'finalized',
          provider_request_id = COALESCE(
            ${input.providerRequestId ?? null},
            provider_request_id
          ),
          actual_cost_usd = ${input.actualCostUsd.toString()}::numeric,
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
      `;

      if (!updated) {
        throw new Error("PostgreSQL did not return the finalized reservation");
      }

      const eventId = crypto.randomUUID();
      const event: Record<string, JsonValue> = {
        ...(input.analytics ?? {}),
        event_id: eventId,
        request_id: updated.request_id,
        reservation_id: updated.id,
        account_id: updated.account_id,
        provider: updated.provider,
        provider_request_id: updated.provider_request_id,
        estimated_cost_usd: toReservation(updated).estimatedCostUsd,
        billed_cost_usd: toReservation(updated).actualCostUsd,
        unfunded_cost_usd: toReservation(updated).unfundedCostUsd,
        usage_source: input.usageSource,
        occurred_at: now.toISOString(),
      };

      // Same transaction as the ledger and reservation update, so the
      // analytics job exists if and only if the finalization committed.
      // Graphile Worker retries delivery with exponential backoff.
      await tx`
        SELECT graphile_worker.add_job(
          ${REQUEST_EVENT_TASK},
          ${tx.json(event)}::json,
          max_attempts => 25
        )
      `;

      return toReservation(updated);
    });
  }

  async release(requestId: string): Promise<Reservation> {
    const accountId = await this.findAccountId(requestId);

    return this.sql.begin(async (tx) => {
      await this.lockAccount(tx, accountId);
      const now = await this.databaseNow(tx);
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

      await tx`
        UPDATE billing_funding_windows AS funding_window
        SET
          reserved_usd = funding_window.reserved_usd - hold.reserved_usd,
          updated_at = ${now}
        FROM billing_reservation_funding_holds AS hold
        WHERE
          hold.reservation_id = ${reservation.id}::uuid
          AND hold.funding_window_id = funding_window.id
      `;
      await tx`
        UPDATE billing_credit_grants AS credit
        SET
          reserved_usd = credit.reserved_usd - hold.reserved_usd,
          updated_at = ${now}
        FROM billing_reservation_credit_holds AS hold
        WHERE
          hold.reservation_id = ${reservation.id}::uuid
          AND hold.credit_grant_id = credit.id
      `;
      await tx`
        UPDATE billing_limit_windows AS limit_window
        SET
          reserved_usd = limit_window.reserved_usd - hold.reserved_usd,
          updated_at = ${now}
        FROM billing_reservation_limit_holds AS hold
        WHERE
          hold.reservation_id = ${reservation.id}::uuid
          AND hold.limit_window_id = limit_window.id
      `;

      await tx`
        DELETE FROM billing_reservation_funding_holds
        WHERE reservation_id = ${reservation.id}::uuid
      `;
      await tx`
        DELETE FROM billing_reservation_credit_holds
        WHERE reservation_id = ${reservation.id}::uuid
      `;
      await tx`
        DELETE FROM billing_reservation_limit_holds
        WHERE reservation_id = ${reservation.id}::uuid
      `;

      const [updated] = await tx<ReservationRow[]>`
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
      `;

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
    const accountId = await this.findAccountId(requestId);

    return this.sql.begin(async (tx) => {
      await this.lockAccount(tx, accountId);
      const now = await this.databaseNow(tx);
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

  private async findAccountId(requestId: string): Promise<string> {
    const [row] = await this.sql<{ account_id: string }[]>`
      SELECT account_id
      FROM billing_reservations
      WHERE request_id = ${requestId}::uuid
    `;
    if (!row) throw new ReservationNotFoundError(requestId);
    return row.account_id;
  }

  private async databaseNow(tx: TransactionSql): Promise<Date> {
    const [row] = await tx<{ now: Date }[]>`
      SELECT transaction_timestamp() AS now
    `;
    if (!row) throw new Error("PostgreSQL did not return its transaction time");
    return row.now;
  }

  private async lockAccount(tx: TransactionSql, accountId: string) {
    await tx`
      SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 0))
    `;
    const [account] = await tx<{ id: string }[]>`
      SELECT id
      FROM billing_accounts
      WHERE id = ${accountId}::uuid
    `;
    if (!account) throw new BillingAccountNotFoundError(accountId);
  }

  private async findReservation(
    tx: TransactionSql,
    requestId: string,
    forUpdate: boolean,
  ): Promise<ReservationRow | undefined> {
    const rows = forUpdate
      ? await tx<ReservationRow[]>`
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
      : await tx<ReservationRow[]>`
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
    return rows[0];
  }

  private async requireReservation(
    tx: TransactionSql,
    requestId: string,
    forUpdate: boolean,
  ) {
    const reservation = await this.findReservation(tx, requestId, forUpdate);
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

  private async materializeFundingWindows(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ) {
    await tx`
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

  private async materializeLimitWindows(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ) {
    await tx`
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

  private async lockLimitWindows(
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

  private async lockAvailableFunding(
    tx: TransactionSql,
    accountId: string,
    now: Date,
  ): Promise<FundingSource[]> {
    const windows = await tx<AvailableSourceRow[]>`
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

    const credits = await tx<AvailableSourceRow[]>`
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

  private async reserveFunding(
    tx: TransactionSql,
    reservationId: string,
    source: FundingSource,
    amountAtoms: bigint,
  ) {
    const amount = Usd.fromAtoms(amountAtoms).toString();
    if (source.kind === "window") {
      await tx`
        UPDATE billing_funding_windows
        SET
          reserved_usd = reserved_usd + ${amount}::numeric,
          updated_at = now()
        WHERE id = ${source.id}::uuid
      `;
      await tx`
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
      `;
      return;
    }

    await tx`
      UPDATE billing_credit_grants
      SET
        reserved_usd = reserved_usd + ${amount}::numeric,
        updated_at = now()
      WHERE id = ${source.id}::uuid
    `;
    await tx`
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
    `;
  }

  private async lockExistingFundingHolds(
    tx: TransactionSql,
    reservationId: string,
  ): Promise<ExistingHold[]> {
    const windows = await tx<ExistingHoldRow[]>`
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
      WHERE hold.reservation_id = ${reservationId}::uuid
      ORDER BY policy.priority, funding_window.window_end, funding_window.id
      FOR UPDATE OF hold, funding_window
    `;
    const credits = await tx<ExistingHoldRow[]>`
      SELECT
        credit.id,
        credit.priority,
        hold.reserved_usd::text,
        credit.expires_at
      FROM billing_reservation_credit_holds AS hold
      INNER JOIN billing_credit_grants AS credit
        ON credit.id = hold.credit_grant_id
      WHERE hold.reservation_id = ${reservationId}::uuid
      ORDER BY credit.priority, credit.expires_at NULLS LAST, credit.id
      FOR UPDATE OF hold, credit
    `;

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

  private async commitExistingHold(
    tx: TransactionSql,
    reservationId: string,
    hold: ExistingHold,
    committedAtoms: bigint,
    now: Date,
  ) {
    const reserved = Usd.fromAtoms(hold.reservedAtoms).toString();
    const committed = Usd.fromAtoms(committedAtoms).toString();

    if (hold.kind === "window") {
      await tx`
        UPDATE billing_funding_windows
        SET
          reserved_usd = reserved_usd - ${reserved}::numeric,
          committed_usd = committed_usd + ${committed}::numeric,
          updated_at = ${now}
        WHERE id = ${hold.id}::uuid
      `;
      if (committedAtoms === 0n) {
        await tx`
          DELETE FROM billing_reservation_funding_holds
          WHERE
            reservation_id = ${reservationId}::uuid
            AND funding_window_id = ${hold.id}::uuid
        `;
      } else {
        await tx`
          UPDATE billing_reservation_funding_holds
          SET
            reserved_usd = 0,
            committed_usd = ${committed}::numeric
          WHERE
            reservation_id = ${reservationId}::uuid
            AND funding_window_id = ${hold.id}::uuid
        `;
      }
      return;
    }

    await tx`
      UPDATE billing_credit_grants
      SET
        reserved_usd = reserved_usd - ${reserved}::numeric,
        committed_usd = committed_usd + ${committed}::numeric,
        updated_at = ${now}
      WHERE id = ${hold.id}::uuid
    `;
    if (committedAtoms === 0n) {
      await tx`
        DELETE FROM billing_reservation_credit_holds
        WHERE
          reservation_id = ${reservationId}::uuid
          AND credit_grant_id = ${hold.id}::uuid
      `;
    } else {
      await tx`
        UPDATE billing_reservation_credit_holds
        SET
          reserved_usd = 0,
          committed_usd = ${committed}::numeric
        WHERE
          reservation_id = ${reservationId}::uuid
          AND credit_grant_id = ${hold.id}::uuid
      `;
    }
  }

  private async commitAdditionalFunding(
    tx: TransactionSql,
    reservationId: string,
    source: FundingSource,
    amountAtoms: bigint,
    now: Date,
  ) {
    const amount = Usd.fromAtoms(amountAtoms).toString();
    if (source.kind === "window") {
      await tx`
        UPDATE billing_funding_windows
        SET
          committed_usd = committed_usd + ${amount}::numeric,
          updated_at = ${now}
        WHERE id = ${source.id}::uuid
      `;
      await tx`
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
      `;
      return;
    }

    await tx`
      UPDATE billing_credit_grants
      SET
        committed_usd = committed_usd + ${amount}::numeric,
        updated_at = ${now}
      WHERE id = ${source.id}::uuid
    `;
    await tx`
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
    `;
  }

  private async finalizeLimitHolds(
    tx: TransactionSql,
    reservationId: string,
    actualCost: Usd,
    now: Date,
  ) {
    const holds = await tx<{ id: string; reserved_usd: string }[]>`
      SELECT
        limit_window.id,
        hold.reserved_usd::text
      FROM billing_reservation_limit_holds AS hold
      INNER JOIN billing_limit_windows AS limit_window
        ON limit_window.id = hold.limit_window_id
      WHERE hold.reservation_id = ${reservationId}::uuid
      ORDER BY limit_window.id
      FOR UPDATE OF hold, limit_window
    `;

    for (const hold of holds) {
      await tx`
        UPDATE billing_limit_windows
        SET
          reserved_usd = reserved_usd - ${hold.reserved_usd}::numeric,
          committed_usd = committed_usd + ${actualCost.toString()}::numeric,
          updated_at = ${now}
        WHERE id = ${hold.id}::uuid
      `;

      if (actualCost.toAtoms() === 0n) {
        await tx`
          DELETE FROM billing_reservation_limit_holds
          WHERE
            reservation_id = ${reservationId}::uuid
            AND limit_window_id = ${hold.id}::uuid
        `;
      } else {
        await tx`
          UPDATE billing_reservation_limit_holds
          SET
            reserved_usd = 0,
            committed_usd = ${actualCost.toString()}::numeric
          WHERE
            reservation_id = ${reservationId}::uuid
            AND limit_window_id = ${hold.id}::uuid
        `;
      }
    }
  }
}
