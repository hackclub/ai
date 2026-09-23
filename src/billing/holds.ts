import type postgres from "postgres";

import type { Statement } from "./locks";
import type { CounterKind, HoldChange } from "./plan";

type Tx = postgres.TransactionSql;

/**
 * Where each kind of counter and its per-reservation holds live. The three
 * pairs share one shape (`reserved_usd`, `committed_usd` on both sides),
 * which is what lets one writer serve them all. Table names are fixed
 * here and escaped as identifiers; nothing caller-supplied reaches them.
 */
export const COUNTER_TABLES = {
  funding_window: {
    counter: "billing_funding_windows",
    holds: "billing_reservation_funding_holds",
    key: "funding_window_id",
  },
  credit_grant: {
    counter: "billing_credit_grants",
    holds: "billing_reservation_credit_holds",
    key: "credit_grant_id",
  },
  limit_window: {
    counter: "billing_limit_windows",
    holds: "billing_reservation_limit_holds",
    key: "limit_window_id",
  },
} as const satisfies Record<
  CounterKind,
  { counter: string; holds: string; key: string }
>;

/**
 * Writes one planned change: moves the counter by `after - before` and
 * stores the hold as `after`, deleting it once it holds nothing. Counter
 * and hold change in the same pipelined batch, so they cannot drift.
 */
export function writeHoldChange(
  tx: Tx,
  reservationId: string,
  change: HoldChange,
): Statement[] {
  const table = COUNTER_TABLES[change.kind];
  const reservedDelta = change.after.reserved.subtract(change.before.reserved);
  const committedDelta = change.after.committed.subtract(change.before.committed);
  const changed = !reservedDelta.isZero() || !committedDelta.isZero();
  const statements: Statement[] = [];

  if (changed) {
    statements.push(tx`
      UPDATE ${tx(table.counter)}
      SET
        reserved_usd = reserved_usd + ${reservedDelta.toString()}::numeric,
        committed_usd = committed_usd + ${committedDelta.toString()}::numeric,
        updated_at = now()
      WHERE id = ${change.counterId}::uuid
    `);
  }

  const empty = change.after.reserved.isZero() && change.after.committed.isZero();
  const existed =
    !change.before.reserved.isZero() || !change.before.committed.isZero();

  if (empty && existed) {
    statements.push(tx`
      DELETE FROM ${tx(table.holds)}
      WHERE
        reservation_id = ${reservationId}::uuid
        AND ${tx(table.key)} = ${change.counterId}::uuid
    `);
  } else if (!empty && changed) {
    statements.push(tx`
      INSERT INTO ${tx(table.holds)} (
        reservation_id,
        ${tx(table.key)},
        reserved_usd,
        committed_usd
      )
      VALUES (
        ${reservationId}::uuid,
        ${change.counterId}::uuid,
        ${change.after.reserved.toString()}::numeric,
        ${change.after.committed.toString()}::numeric
      )
      ON CONFLICT (reservation_id, ${tx(table.key)}) DO UPDATE SET
        reserved_usd = EXCLUDED.reserved_usd,
        committed_usd = EXCLUDED.committed_usd
    `);
  }

  return statements;
}

/**
 * Returns every reserved amount a reservation holds to its counters and
 * deletes the holds. Set-based, so it needs no prior read of the holds.
 * Only valid before finalization: a finalized hold carries committed money
 * that must stay.
 */
export function releaseAllHolds(
  tx: Tx,
  reservationId: string,
): Statement[] {
  return Object.values(COUNTER_TABLES).flatMap((table) => [
    tx`
      UPDATE ${tx(table.counter)} AS counter
      SET
        reserved_usd = counter.reserved_usd - hold.reserved_usd,
        updated_at = now()
      FROM ${tx(table.holds)} AS hold
      WHERE
        hold.reservation_id = ${reservationId}::uuid
        AND hold.${tx(table.key)} = counter.id
    `,
    tx`
      DELETE FROM ${tx(table.holds)}
      WHERE reservation_id = ${reservationId}::uuid
    `,
  ]);
}
