import type postgres from "postgres";

import {
  BillingAccountNotFoundError,
  ReservationNotFoundError,
} from "./errors";

/**
 * Locking reads used inside the engine's transactions. Every function takes
 * the transaction handle and returns a pending query so callers can
 * pipeline several in one `Promise.all` (statements execute in issue
 * order).
 */

export type ReservationRow = {
  id: string;
  request_id: string;
  account_id: string;
  provider: string;
  provider_request_id: string | null;
  state:
    | "reserved"
    | "pending_reconciliation"
    | "finalized"
    | "released";
  estimated_cost_usd: string;
  actual_cost_usd: string | null;
  unfunded_cost_usd: string;
  expires_at: Date;
};

export type LimitWindowRow = {
  id: string;
  policy_name: string;
  available_usd: string;
};

export type AvailableSourceRow = {
  id: string;
  priority: number;
  available_usd: string;
  expires_at: Date | null;
};

export type ExistingHoldRow = {
  id: string;
  priority: number;
  reserved_usd: string;
  expires_at: Date | null;
};

/** A statement queued for one pipelined round trip. */
export type Statement = postgres.PendingQuery<postgres.Row[]>;

/**
 * Takes the account's advisory lock, confirms the account exists, and
 * reads the transaction clock in one round trip. The lock is taken in the
 * FROM clause so it is held before the account row is read.
 */
export async function lockAccount(
  tx: postgres.TransactionSql,
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
    FROM pg_advisory_xact_lock(hashtextextended(${accountId}::uuid::text, 0))
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
export async function lockReservationAccount(
  tx: postgres.TransactionSql,
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

export function selectReservation(
  tx: postgres.TransactionSql,
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

export async function requireReservation(
  tx: postgres.TransactionSql,
  requestId: string,
  forUpdate: boolean,
) {
  const [reservation] = await selectReservation(
    tx,
    requestId,
    forUpdate,
  );
  if (!reservation) throw new ReservationNotFoundError(requestId);
  return reservation;
}

export function lockLimitWindows(
  tx: postgres.TransactionSql,
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

export function lockAvailableWindows(
  tx: postgres.TransactionSql,
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

export function lockAvailableCredits(
  tx: postgres.TransactionSql,
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

/** Hold rows are keyed by request id so they need no prior lookup. */
export function lockWindowHolds(tx: postgres.TransactionSql, requestId: string) {
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

export function lockCreditHolds(tx: postgres.TransactionSql, requestId: string) {
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

export function lockLimitHolds(tx: postgres.TransactionSql, requestId: string) {
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
