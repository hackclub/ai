import type postgres from "postgres";

/**
 * Creates the current funding and limit windows for an account's enabled
 * policies, idempotently (`ON CONFLICT DO NOTHING`). Called at the head of
 * every reservation and late finalization so the locking reads that follow
 * in the same pipelined round trip find the windows present.
 */

export function materializeFundingWindows(
  tx: postgres.TransactionSql,
  accountId: string,
) {
  return tx`
    WITH policies AS (
      SELECT
        policy.*,
        date_trunc(
          policy.cadence,
          now() AT TIME ZONE policy.timezone
        ) AS local_start
      FROM billing_funding_policies AS policy
      WHERE
        policy.account_id = ${accountId}::uuid
        AND policy.enabled
        AND policy.effective_from <= now()
        AND (
          policy.effective_until IS NULL
          OR policy.effective_until > now()
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

export function materializeLimitWindows(
  tx: postgres.TransactionSql,
  accountId: string,
) {
  return tx`
    WITH policies AS (
      SELECT
        policy.*,
        CASE
          WHEN cadence = 'lifetime' THEN effective_from
          ELSE date_trunc(
            policy.cadence,
            now() AT TIME ZONE policy.timezone
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
              now() AT TIME ZONE policy.timezone
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
        AND policy.effective_from <= now()
        AND (
          policy.effective_until IS NULL
          OR policy.effective_until > now()
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
