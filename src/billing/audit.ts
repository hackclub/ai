import type postgres from "postgres";

/**
 * Read-only consistency check of the billing projection. Counters
 * (`reserved_usd`, `committed_usd` on windows and grants) are a cache of
 * their hold rows, and every reservation's money must be accounted for.
 * An empty result means the books balance; each row names one thing that
 * does not.
 *
 * Checked, per counter:
 * - counter reserved/committed equal the sum of its holds.
 * Checked, per reservation:
 * - `finalized`: actual = committed funding + unfunded; nothing still
 *   reserved; exactly one usage ledger entry equal to actual when actual
 *   is positive, none otherwise.
 * - `reserved`: funding holds reserve exactly the estimate, nothing
 *   committed.
 * - `released`: no holds at all.
 * - `pending_reconciliation`: nothing committed (the hold may or may not
 *   survive, depending on whether it was released first).
 *
 * Integration tests run it after every scenario; it is also safe to run
 * against production, scoped to one account or across all of them.
 */
export type BillingDrift = {
  kind: string;
  id: string;
  problem: string;
};

export async function findBillingDrift(
  sql: postgres.Sql,
  accountId?: string,
): Promise<BillingDrift[]> {
  const account = accountId ?? null;
  return sql<BillingDrift[]>`
    WITH
    funding_holds AS (
      SELECT reservation_id, reserved_usd, committed_usd
      FROM billing_reservation_funding_holds
      UNION ALL
      SELECT reservation_id, reserved_usd, committed_usd
      FROM billing_reservation_credit_holds
    ),
    reservation_totals AS (
      SELECT
        reservation.id,
        reservation.state,
        reservation.estimated_cost_usd,
        reservation.actual_cost_usd,
        reservation.unfunded_cost_usd,
        COALESCE(funding.reserved, 0) AS funding_reserved,
        COALESCE(funding.committed, 0) AS funding_committed,
        COALESCE(limits.reserved, 0) AS limit_reserved,
        COALESCE(limits.committed, 0) AS limit_committed,
        COALESCE(funding.count, 0) + COALESCE(limits.count, 0) AS hold_count,
        ledger.count AS ledger_count,
        ledger.amount AS ledger_amount
      FROM billing_reservations AS reservation
      LEFT JOIN LATERAL (
        SELECT
          sum(reserved_usd) AS reserved,
          sum(committed_usd) AS committed,
          count(*) AS count
        FROM funding_holds
        WHERE reservation_id = reservation.id
      ) AS funding ON true
      LEFT JOIN LATERAL (
        SELECT
          sum(reserved_usd) AS reserved,
          sum(committed_usd) AS committed,
          count(*) AS count
        FROM billing_reservation_limit_holds
        WHERE reservation_id = reservation.id
      ) AS limits ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS count, sum(amount_usd) AS amount
        FROM billing_ledger_entries
        WHERE reservation_id = reservation.id AND category = 'usage'
      ) AS ledger ON true
      WHERE ${account}::uuid IS NULL OR reservation.account_id = ${account}::uuid
    )

    SELECT 'funding_window' AS kind, counter.id::text AS id,
      format('counter %s/%s, holds %s/%s',
        counter.reserved_usd, counter.committed_usd,
        COALESCE(sum(hold.reserved_usd), 0), COALESCE(sum(hold.committed_usd), 0)
      ) AS problem
    FROM billing_funding_windows AS counter
    LEFT JOIN billing_reservation_funding_holds AS hold
      ON hold.funding_window_id = counter.id
    WHERE ${account}::uuid IS NULL OR counter.account_id = ${account}::uuid
    GROUP BY counter.id
    HAVING
      counter.reserved_usd <> COALESCE(sum(hold.reserved_usd), 0)
      OR counter.committed_usd <> COALESCE(sum(hold.committed_usd), 0)

    UNION ALL
    SELECT 'credit_grant', counter.id::text,
      format('counter %s/%s, holds %s/%s',
        counter.reserved_usd, counter.committed_usd,
        COALESCE(sum(hold.reserved_usd), 0), COALESCE(sum(hold.committed_usd), 0)
      )
    FROM billing_credit_grants AS counter
    LEFT JOIN billing_reservation_credit_holds AS hold
      ON hold.credit_grant_id = counter.id
    WHERE ${account}::uuid IS NULL OR counter.account_id = ${account}::uuid
    GROUP BY counter.id
    HAVING
      counter.reserved_usd <> COALESCE(sum(hold.reserved_usd), 0)
      OR counter.committed_usd <> COALESCE(sum(hold.committed_usd), 0)

    UNION ALL
    SELECT 'limit_window', counter.id::text,
      format('counter %s/%s, holds %s/%s',
        counter.reserved_usd, counter.committed_usd,
        COALESCE(sum(hold.reserved_usd), 0), COALESCE(sum(hold.committed_usd), 0)
      )
    FROM billing_limit_windows AS counter
    LEFT JOIN billing_reservation_limit_holds AS hold
      ON hold.limit_window_id = counter.id
    WHERE ${account}::uuid IS NULL OR counter.account_id = ${account}::uuid
    GROUP BY counter.id
    HAVING
      counter.reserved_usd <> COALESCE(sum(hold.reserved_usd), 0)
      OR counter.committed_usd <> COALESCE(sum(hold.committed_usd), 0)

    UNION ALL
    SELECT 'reservation', id::text, problem
    FROM reservation_totals,
    LATERAL (
      SELECT format(
        'finalized at %s but funding committed %s + unfunded %s',
        actual_cost_usd, funding_committed, unfunded_cost_usd
      ) AS problem
      WHERE state = 'finalized'
        AND actual_cost_usd <> funding_committed + unfunded_cost_usd
      UNION ALL
      SELECT format('finalized but still reserves %s', funding_reserved + limit_reserved)
      WHERE state = 'finalized' AND funding_reserved + limit_reserved <> 0
      UNION ALL
      SELECT format(
        'finalized at %s but has %s usage ledger entries totalling %s',
        actual_cost_usd, ledger_count, ledger_amount
      )
      WHERE state = 'finalized' AND (
        (actual_cost_usd > 0 AND (ledger_count <> 1 OR ledger_amount <> actual_cost_usd))
        OR (actual_cost_usd = 0 AND ledger_count <> 0)
      )
      UNION ALL
      SELECT format('%s but has a usage ledger entry', state)
      WHERE state <> 'finalized' AND ledger_count <> 0
      UNION ALL
      SELECT format(
        'reserved %s but funding holds reserve %s',
        estimated_cost_usd, funding_reserved
      )
      WHERE state = 'reserved' AND funding_reserved <> estimated_cost_usd
      UNION ALL
      SELECT format('%s but holds commit %s', state, funding_committed + limit_committed)
      WHERE state IN ('reserved', 'pending_reconciliation')
        AND funding_committed + limit_committed <> 0
      UNION ALL
      SELECT format('released but still has %s holds', hold_count)
      WHERE state = 'released' AND hold_count <> 0
    ) AS checks

    ORDER BY 1, 2, 3
  `;
}
