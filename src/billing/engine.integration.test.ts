import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../analytics/worker";
import { integrationDatabaseUrl, integrationTestFor } from "../test/integration-db";
import { findBillingDrift } from "./audit";
import { BillingEngine } from "./engine";
import {
  InsufficientFundsError,
  InvalidReservationStateError,
  LimitExceededError,
  ReservationConflictError,
} from "./errors";
import { Usd } from "./money";

const databaseUrl = integrationDatabaseUrl("BILLING_TEST_DATABASE_URL");
const integrationTest = integrationTestFor(databaseUrl);
const runId = crypto.randomUUID().slice(0, 8);

describe("BillingEngine with PostgreSQL", () => {
  let sql: Sql | undefined;
  let engine: BillingEngine | undefined;
  let accountId: string;
  const firstRequestId = crypto.randomUUID();
  const secondRequestId = crypto.randomUUID();
  const createdAccountIds: string[] = [];

  /** A fresh account with a daily allowance and, optionally, a daily limit. */
  const newAccount = async (allowance: string, limit?: string) => {
    if (!sql) throw new Error("Integration database unavailable");
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
    if (!engine) throw new Error("Integration database unavailable");
    return engine.reserve({
      requestId,
      accountId: account,
      provider: "openrouter",
      estimatedCostUsd: Usd.parse(estimate),
    });
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 4 });
    engine = new BillingEngine(sql);
    await migrateJobQueue(databaseUrl);
    accountId = await newAccount("1", "0.8");
  });

  // Every scenario must leave the books balanced: counters equal their
  // holds, and each reservation's money is fully accounted for.
  afterEach(async () => {
    if (!sql) return;
    for (const id of createdAccountIds) {
      expect(await findBillingDrift(sql, id)).toEqual([]);
    }
  });

  afterAll(async () => {
    if (!sql) return;
    for (const id of createdAccountIds) {
      await sql`DELETE FROM request_event_outbox WHERE payload->>'account_id' = ${id}`;
      await sql`DELETE FROM billing_ledger_entries WHERE account_id = ${id}::uuid`;
      for (const table of [
        "billing_reservation_funding_holds",
        "billing_reservation_credit_holds",
        "billing_reservation_limit_holds",
      ]) {
        await sql`
          DELETE FROM ${sql(table)}
          WHERE reservation_id IN (SELECT id FROM billing_reservations WHERE account_id = ${id}::uuid)
        `;
      }
      for (const table of [
        "billing_reservations",
        "billing_funding_windows",
        "billing_limit_windows",
        "billing_credit_grants",
        "billing_funding_policies",
        "billing_limit_policies",
        "billing_admin_events",
      ]) {
        await sql`DELETE FROM ${sql(table)} WHERE account_id = ${id}::uuid`;
      }
      await sql`DELETE FROM billing_accounts WHERE id = ${id}::uuid`;
    }
    await sql.end();
  });

  // The tests below run in order against one account with a $1 daily
  // allowance and a $0.80 daily limit. Later tests build on earlier state,
  // so a failure points at the first invariant that broke.

  integrationTest("reserve is idempotent for the same request id", async () => {
    const [first, repeated] = await Promise.all([
      reserve(firstRequestId, "0.75"),
      reserve(firstRequestId, "0.75"),
    ]);
    expect(repeated.id).toBe(first.id);
  });

  integrationTest("refuses a reservation the limit policy cannot hold", async () => {
    // $0.75 is held; another $0.10 would exceed the $0.80 limit.
    await expect(reserve(crypto.randomUUID(), "0.1")).rejects.toBeInstanceOf(LimitExceededError);
  });

  integrationTest("finalizes with the actual cost and no unfunded remainder", async () => {
    if (!engine) throw new Error("Integration database unavailable");
    const finalized = await engine.finalize({
      requestId: firstRequestId,
      actualCostUsd: Usd.parse("0.5"),
      usageSource: "provider_reported",
      providerRequestId: `gen-integration-first-${runId}`,
      analytics: {
        request_body: '{"prompt":"six seven mango"}',
        response_body: '{"answer":"found"}',
      },
    });
    expect(finalized.state).toBe("finalized");
    expect(finalized.actualCostUsd).toBe("0.500000000000");
    expect(finalized.unfundedCostUsd).toBe("0.000000000000");
  });

  integrationTest("release is idempotent", async () => {
    if (!engine) throw new Error("Integration database unavailable");
    const second = await reserve(secondRequestId, "0.2");
    expect((await engine.release(secondRequestId)).id).toBe(second.id);
    expect((await engine.release(secondRequestId)).state).toBe("released");
  });

  integrationTest("a zero estimate can still finalize with a real cost", async () => {
    if (!engine) throw new Error("Integration database unavailable");
    const requestId = crypto.randomUUID();
    await reserve(requestId, "0");
    const finalized = await engine.finalize({
      requestId,
      actualCostUsd: Usd.parse("0.01"),
      usageSource: "reconciled",
      providerRequestId: `gen-integration-zero-estimate-${runId}`,
    });
    expect(finalized.actualCostUsd).toBe("0.010000000000");
    expect(finalized.unfundedCostUsd).toBe("0.000000000000");
  });

  integrationTest("records limit overage instead of clamping the charge", async () => {
    if (!engine || !sql) throw new Error("Integration database unavailable");
    const requestId = crypto.randomUUID();
    await reserve(requestId, "0.1");
    const overage = await engine.finalize({
      requestId,
      actualCostUsd: Usd.parse("0.39"),
      usageSource: "reconciled",
      providerRequestId: `gen-integration-overage-${runId}`,
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

  integrationTest("every finalization leaves a ledger entry and an outbox event", async () => {
    if (!sql) throw new Error("Integration database unavailable");
    const [audit] = await sql`
      SELECT
        (SELECT count(*)::integer FROM billing_ledger_entries WHERE account_id = ${accountId}::uuid) AS ledger_count,
        (SELECT count(*)::integer FROM request_event_outbox WHERE payload->>'account_id' = ${accountId}::text) AS job_count
    `;
    expect(audit).toEqual({ ledger_count: 3, job_count: 3 });
  });

  integrationTest("repeating a finalization with the same cost is a no-op", async () => {
    if (!engine) throw new Error("Integration database unavailable");
    const again = await engine.finalize({
      requestId: firstRequestId,
      actualCostUsd: Usd.parse("0.5"),
      usageSource: "provider_reported",
    });
    expect(again.state).toBe("finalized");
    expect(again.requestId).toBe(firstRequestId);
  });

  integrationTest("refuses to hand a released reservation back to a retrying caller", async () => {
    // secondRequestId was released above; a retry must not dispatch against it.
    await expect(reserve(secondRequestId, "0.2")).rejects.toBeInstanceOf(
      InvalidReservationStateError,
    );
  });

  integrationTest("refuses replays that disagree with the original", async () => {
    if (!engine) throw new Error("Integration database unavailable");
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

  integrationTest(
    "finalizes a reservation the expiry sweeper released, funding it from current windows",
    async () => {
      if (!engine || !sql) throw new Error("Integration database unavailable");
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
        providerRequestId: `gen-integration-late-${runId}`,
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

  integrationTest(
    "spills from the allowance into credit, returns the unused hold, and books the rest as unfunded",
    async () => {
      if (!engine || !sql) throw new Error("Integration database unavailable");
      const spillAccountId = await newAccount("0.1");
      await sql`
        INSERT INTO billing_credit_grants (account_id, source, granted_usd)
        VALUES (${spillAccountId}::uuid, 'promotional', 0.2)
      `;
      const balances = async () => {
        if (!sql) throw new Error("Integration database unavailable");
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

  integrationTest("a zero-cost finalization returns every hold and writes no ledger entry", async () => {
    if (!engine || !sql) throw new Error("Integration database unavailable");
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

  integrationTest("serializes concurrent reservations so funding cannot be overspent", async () => {
    if (!sql) throw new Error("Integration database unavailable");
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
