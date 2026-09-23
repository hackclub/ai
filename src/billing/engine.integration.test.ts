import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { testDatabase } from "../test/database";
import { findBillingDrift } from "./audit";
import { BillingEngine } from "./engine";
import {
  InsufficientFundsError,
  InvalidReservationStateError,
  LimitExceededError,
  ReservationConflictError,
} from "./errors";
import { Usd } from "./money";

const { sql } = await testDatabase();

describe("BillingEngine with PostgreSQL", () => {
  const engine = new BillingEngine(sql);
  let accountId: string;
  const firstRequestId = crypto.randomUUID();
  const secondRequestId = crypto.randomUUID();
  const createdAccountIds: string[] = [];

  /** A fresh account with a daily allowance and, optionally, a daily limit. */
  const newAccount = async (allowance: string, limit?: string) => {
    const id = crypto.randomUUID();
    createdAccountIds.push(id);
    await sql`
      INSERT INTO billing_accounts (id, owner_type, owner_id)
      VALUES (${id}::uuid, 'user', ${crypto.randomUUID()}::uuid)
    `;
    await sql`
      INSERT INTO billing_funding_policies (account_id, name, cadence, amount_usd)
      VALUES (${id}::uuid, 'Allowance', 'day', ${allowance}::numeric)
    `;
    if (limit !== undefined) {
      await sql`
        INSERT INTO billing_limit_policies (account_id, name, cadence, limit_usd)
        VALUES (${id}::uuid, 'Limit', 'day', ${limit}::numeric)
      `;
    }
    return id;
  };

  const reserve = (requestId: string, estimate: string, account = accountId) => {
    return engine.reserve({
      requestId,
      accountId: account,
      provider: "openrouter",
      estimatedCostUsd: Usd.parse(estimate),
    });
  };

  beforeAll(async () => {
    accountId = await newAccount("1", "0.8");
  });

  // Every scenario must leave the books balanced: counters equal their
  // holds, and each reservation's money is fully accounted for.
  afterEach(async () => {
    for (const id of createdAccountIds) {
      expect(await findBillingDrift(sql, id)).toEqual([]);
    }
  });

  // The tests below run in order against one account with a $1 daily
  // allowance and a $0.80 daily limit. Later tests build on earlier state,
  // so a failure points at the first invariant that broke.

  test("reserve is idempotent for the same request id", async () => {
    const [first, repeated] = await Promise.all([
      reserve(firstRequestId, "0.75"),
      reserve(firstRequestId, "0.75"),
    ]);
    expect(repeated.id).toBe(first.id);
  });

  test("refuses a reservation the limit policy cannot hold", async () => {
    // $0.75 is held; another $0.10 would exceed the $0.80 limit.
    await expect(reserve(crypto.randomUUID(), "0.1")).rejects.toBeInstanceOf(LimitExceededError);
  });

  test("finalizes with the actual cost and no unfunded remainder", async () => {
    const finalized = await engine.finalize({
      requestId: firstRequestId,
      actualCostUsd: Usd.parse("0.5"),
      usageSource: "provider_reported",
      providerRequestId: `gen-integration-first`,
      analytics: {
        request_body: '{"prompt":"six seven mango"}',
        response_body: '{"answer":"found"}',
      },
    });
    expect(finalized.state).toBe("finalized");
    expect(finalized.actualCostUsd).toBe("0.500000000000");
    expect(finalized.unfundedCostUsd).toBe("0.000000000000");
  });

  test("release is idempotent", async () => {
    const second = await reserve(secondRequestId, "0.2");
    expect((await engine.release(secondRequestId)).id).toBe(second.id);
    expect((await engine.release(secondRequestId)).state).toBe("released");
  });

  test("a zero estimate can still finalize with a real cost", async () => {
    const requestId = crypto.randomUUID();
    await reserve(requestId, "0");
    const finalized = await engine.finalize({
      requestId,
      actualCostUsd: Usd.parse("0.01"),
      usageSource: "reconciled",
      providerRequestId: `gen-integration-zero-estimate`,
    });
    expect(finalized.actualCostUsd).toBe("0.010000000000");
    expect(finalized.unfundedCostUsd).toBe("0.000000000000");
  });

  test("records limit overage instead of clamping the charge", async () => {
    const requestId = crypto.randomUUID();
    await reserve(requestId, "0.1");
    const overage = await engine.finalize({
      requestId,
      actualCostUsd: Usd.parse("0.39"),
      usageSource: "reconciled",
      providerRequestId: `gen-integration-overage`,
    });
    // Funding still covers it ($1 allowance), so nothing is unfunded...
    expect(overage.unfundedCostUsd).toBe("0.000000000000");

    // ...but $0.50 + $0.01 + $0.39 = $0.90 exceeds the $0.80 limit by $0.10.
    const [limit] = await sql`
      SELECT committed_usd::text, reserved_usd::text, overage_usd::text
      FROM billing_limit_windows
      WHERE account_id = ${accountId}::uuid
    `;
    expect(limit).toEqual({
      committed_usd: "0.900000000000",
      reserved_usd: "0.000000000000",
      overage_usd: "0.100000000000",
    });
  });

  test("every finalization leaves a ledger entry and an outbox event", async () => {
    const [audit] = await sql`
      SELECT
        (SELECT count(*)::integer FROM billing_ledger_entries WHERE account_id = ${accountId}::uuid) AS ledger_count,
        (SELECT count(*)::integer FROM request_event_outbox WHERE payload->>'account_id' = ${accountId}::text) AS job_count
    `;
    expect(audit).toEqual({ ledger_count: 3, job_count: 3 });
  });

  test("repeating a finalization with the same cost is a no-op", async () => {
    const again = await engine.finalize({
      requestId: firstRequestId,
      actualCostUsd: Usd.parse("0.5"),
      usageSource: "provider_reported",
    });
    expect(again.state).toBe("finalized");
    expect(again.requestId).toBe(firstRequestId);
  });

  test("refuses to hand a released reservation back to a retrying caller", async () => {
    // secondRequestId was released above; a retry must not dispatch against it.
    await expect(reserve(secondRequestId, "0.2")).rejects.toBeInstanceOf(
      InvalidReservationStateError,
    );
  });

  test("refuses replays that disagree with the original", async () => {
    // firstRequestId was reserved at $0.75 and finalized at $0.50.
    await expect(
      engine.finalize({
        requestId: firstRequestId,
        actualCostUsd: Usd.parse("0.51"),
        usageSource: "provider_reported",
      }),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    await expect(engine.release(firstRequestId)).rejects.toBeInstanceOf(
      InvalidReservationStateError,
    );

    const replayAccountId = await newAccount("1");
    const requestId = crypto.randomUUID();
    await reserve(requestId, "0.01", replayAccountId);
    await expect(reserve(requestId, "0.02", replayAccountId)).rejects.toBeInstanceOf(
      ReservationConflictError,
    );
    await engine.release(requestId);
  });

  test(
    "finalizes a reservation the expiry sweeper released, funding it from current windows",
    async () => {
      const lateAccountId = await newAccount("1", "0.8");

      // A long request: reserved, swept by expiry, then settled after all.
      const requestId = crypto.randomUUID();
      await reserve(requestId, "0.2", lateAccountId);
      expect((await engine.release(requestId)).state).toBe("released");
      expect((await engine.markPendingReconciliation(requestId, "stream outlived hold")).state).toBe(
        "pending_reconciliation",
      );

      const finalized = await engine.finalize({
        requestId,
        actualCostUsd: Usd.parse("0.3"),
        usageSource: "reconciled",
        providerRequestId: `gen-integration-late`,
      });
      expect(finalized.state).toBe("finalized");
      expect(finalized.actualCostUsd).toBe("0.300000000000");
      expect(finalized.unfundedCostUsd).toBe("0.000000000000");

      const [row] = await sql`
        SELECT
          (SELECT amount_usd::text FROM billing_ledger_entries
           WHERE account_id = ${lateAccountId}::uuid AND category = 'usage') AS ledger,
          (SELECT reserved_usd::text || '/' || committed_usd::text FROM billing_funding_windows
           WHERE account_id = ${lateAccountId}::uuid) AS funding,
          (SELECT reserved_usd::text || '/' || committed_usd::text FROM billing_limit_windows
           WHERE account_id = ${lateAccountId}::uuid) AS limit_window
      `;
      expect(row).toEqual({
        ledger: "0.300000000000",
        funding: "0.000000000000/0.300000000000",
        limit_window: "0.000000000000/0.300000000000",
      });
    },
  );

  test(
    "spills from the allowance into credit, returns the unused hold, and books the rest as unfunded",
    async () => {
      const spillAccountId = await newAccount("0.1");
      await sql`
        INSERT INTO billing_credit_grants (account_id, source, granted_usd)
        VALUES (${spillAccountId}::uuid, 'promotional', 0.2)
      `;
      const balances = async () => {
        const [row] = await sql`
          SELECT
            (SELECT reserved_usd::text || '/' || committed_usd::text
             FROM billing_funding_windows WHERE account_id = ${spillAccountId}::uuid) AS window,
            (SELECT reserved_usd::text || '/' || committed_usd::text
             FROM billing_credit_grants WHERE account_id = ${spillAccountId}::uuid) AS credit
        `;
        return row;
      };

      // $0.25 needs all of the $0.10 allowance and $0.15 of the credit.
      const requestId = crypto.randomUUID();
      await reserve(requestId, "0.25", spillAccountId);
      expect(await balances()).toEqual({
        window: "0.100000000000/0.000000000000",
        credit: "0.150000000000/0.000000000000",
      });

      // Only $0.05 of headroom is left, so a $0.06 estimate is refused.
      await expect(reserve(crypto.randomUUID(), "0.06", spillAccountId)).rejects.toBeInstanceOf(
        InsufficientFundsError,
      );

      // The provider charged $0.40: $0.30 is fundable, $0.10 is not.
      const finalized = await engine.finalize({
        requestId,
        actualCostUsd: Usd.parse("0.4"),
        usageSource: "provider_reported",
      });
      expect(finalized.unfundedCostUsd).toBe("0.100000000000");
      expect(await balances()).toEqual({
        window: "0.000000000000/0.100000000000",
        credit: "0.000000000000/0.200000000000",
      });
    },
  );

  test("a zero-cost finalization returns every hold and writes no ledger entry", async () => {
    const requestId = crypto.randomUUID();
    await reserve(requestId, "0.05", await newAccount("1", "0.5"));
    const finalized = await engine.finalize({
      requestId,
      actualCostUsd: Usd.zero,
      usageSource: "provider_reported",
    });
    expect(finalized.actualCostUsd).toBe("0.000000000000");

    const [row] = await sql`
      SELECT
        (SELECT count(*)::integer FROM billing_reservation_funding_holds WHERE reservation_id = ${finalized.id}::uuid)
        + (SELECT count(*)::integer FROM billing_reservation_limit_holds WHERE reservation_id = ${finalized.id}::uuid)
          AS holds,
        (SELECT count(*)::integer FROM billing_ledger_entries WHERE reservation_id = ${finalized.id}::uuid) AS ledger
    `;
    expect(row).toEqual({ holds: 0, ledger: 0 });
  });

  test("serializes concurrent reservations so funding cannot be overspent", async () => {
    const concurrencyAccountId = await newAccount("1");
    const attempts = await Promise.allSettled([
      reserve(crypto.randomUUID(), "0.75", concurrencyAccountId),
      reserve(crypto.randomUUID(), "0.75", concurrencyAccountId),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);

    const [funding] = await sql`
      SELECT reserved_usd::text, committed_usd::text
      FROM billing_funding_windows
      WHERE account_id = ${concurrencyAccountId}::uuid
    `;
    expect(funding).toEqual({ reserved_usd: "0.750000000000", committed_usd: "0.000000000000" });
  });
});
