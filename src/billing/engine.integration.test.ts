import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../analytics/worker";
import { BillingEngine } from "./engine";
import { InvalidReservationStateError, LimitExceededError } from "./errors";
import { Usd } from "./money";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const runId = crypto.randomUUID().slice(0, 8);

describe("BillingEngine with PostgreSQL", () => {
  let sql: Sql | undefined;
  let engine: BillingEngine | undefined;
  let accountId: string;
  let firstRequestId: string;
  let secondRequestId: string;
  let zeroEstimateRequestId: string;
  let overageRequestId: string;
  const createdAccountIds: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;

    sql = postgres(databaseUrl, { max: 4 });
    engine = new BillingEngine(sql);
    await migrateJobQueue(databaseUrl);
    accountId = crypto.randomUUID();
    createdAccountIds.push(accountId);
    firstRequestId = crypto.randomUUID();
    secondRequestId = crypto.randomUUID();
    zeroEstimateRequestId = crypto.randomUUID();
    overageRequestId = crypto.randomUUID();

    await sql`
      INSERT INTO billing_accounts (id, owner_type, owner_id)
      VALUES (${accountId}::uuid, 'user', ${crypto.randomUUID()}::uuid)
    `;
    await sql`
      INSERT INTO billing_funding_policies (
        account_id,
        name,
        cadence,
        amount_usd,
        priority
      )
      VALUES (${accountId}::uuid, 'Daily test allowance', 'day', 1, 100)
    `;
    await sql`
      INSERT INTO billing_limit_policies (
        account_id,
        name,
        cadence,
        limit_usd
      )
      VALUES (${accountId}::uuid, 'Daily test limit', 'day', 0.8)
    `;
  });

  afterAll(async () => {
    if (!sql) return;

    for (const cleanupAccountId of createdAccountIds) {
      await sql`
        DELETE FROM request_event_outbox
        WHERE payload->>'account_id' = ${cleanupAccountId}
      `;
      await sql`
        DELETE FROM billing_ledger_entries
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_reservation_funding_holds
        WHERE reservation_id IN (
          SELECT id
          FROM billing_reservations
          WHERE account_id = ${cleanupAccountId}::uuid
        )
      `;
      await sql`
        DELETE FROM billing_reservation_credit_holds
        WHERE reservation_id IN (
          SELECT id
          FROM billing_reservations
          WHERE account_id = ${cleanupAccountId}::uuid
        )
      `;
      await sql`
        DELETE FROM billing_reservation_limit_holds
        WHERE reservation_id IN (
          SELECT id
          FROM billing_reservations
          WHERE account_id = ${cleanupAccountId}::uuid
        )
      `;
      await sql`
        DELETE FROM billing_reservations
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_funding_windows
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_limit_windows
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_credit_grants
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_funding_policies
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_limit_policies
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_admin_events
        WHERE account_id = ${cleanupAccountId}::uuid
      `;
      await sql`
        DELETE FROM billing_accounts
        WHERE id = ${cleanupAccountId}::uuid
      `;
    }
    await sql.end();
  });

  // The tests below run in order against one account with a $1 daily
  // allowance and a $0.80 daily limit. Later tests build on earlier state,
  // so a failure points at the first invariant that broke.

  integrationTest("reserve is idempotent for the same request id", async () => {
    if (!engine) throw new Error("Integration database unavailable");

    const [first, repeated] = await Promise.all([
      engine.reserve({
        requestId: firstRequestId,
        accountId,
        provider: "openrouter",
        estimatedCostUsd: Usd.parse("0.75"),
      }),
      engine.reserve({
        requestId: firstRequestId,
        accountId,
        provider: "openrouter",
        estimatedCostUsd: Usd.parse("0.75"),
      }),
    ]);

    expect(repeated.id).toBe(first.id);
  });

  integrationTest("refuses a reservation the limit policy cannot hold", async () => {
    if (!engine) throw new Error("Integration database unavailable");

    // $0.75 is held; another $0.10 would exceed the $0.80 limit.
    await expect(
      engine.reserve({
        requestId: crypto.randomUUID(),
        accountId,
        provider: "openrouter",
        estimatedCostUsd: Usd.parse("0.1"),
      }),
    ).rejects.toBeInstanceOf(LimitExceededError);
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

    const second = await engine.reserve({
      requestId: secondRequestId,
      accountId,
      provider: "openrouter",
      estimatedCostUsd: Usd.parse("0.2"),
    });
    expect((await engine.release(secondRequestId)).id).toBe(second.id);
    expect((await engine.release(secondRequestId)).state).toBe("released");
  });

  integrationTest("a zero estimate can still finalize with a real cost", async () => {
    if (!engine) throw new Error("Integration database unavailable");

    await engine.reserve({
      requestId: zeroEstimateRequestId,
      accountId,
      provider: "openrouter",
      estimatedCostUsd: Usd.zero,
    });
    const finalized = await engine.finalize({
      requestId: zeroEstimateRequestId,
      actualCostUsd: Usd.parse("0.01"),
      usageSource: "reconciled",
      providerRequestId: `gen-integration-zero-estimate-${runId}`,
    });
    expect(finalized.actualCostUsd).toBe("0.010000000000");
    expect(finalized.unfundedCostUsd).toBe("0.000000000000");
  });

  integrationTest("records limit overage instead of clamping the charge", async () => {
    if (!engine || !sql) throw new Error("Integration database unavailable");

    await engine.reserve({
      requestId: overageRequestId,
      accountId,
      provider: "openrouter",
      estimatedCostUsd: Usd.parse("0.1"),
    });
    const overage = await engine.finalize({
      requestId: overageRequestId,
      actualCostUsd: Usd.parse("0.39"),
      usageSource: "reconciled",
      providerRequestId: `gen-integration-overage-${runId}`,
    });
    // Funding still covers it ($1 allowance), so nothing is unfunded...
    expect(overage.unfundedCostUsd).toBe("0.000000000000");

    // ...but $0.50 + $0.01 + $0.39 = $0.90 exceeds the $0.80 limit by $0.10.
    const [limit] = await sql<
      { committed_usd: string; reserved_usd: string; overage_usd: string }[]
    >`
      SELECT
        committed_usd::text,
        reserved_usd::text,
        overage_usd::text
      FROM billing_limit_windows
      WHERE account_id = ${accountId}::uuid
    `;
    expect(limit?.committed_usd).toBe("0.900000000000");
    expect(limit?.reserved_usd).toBe("0.000000000000");
    expect(limit?.overage_usd).toBe("0.100000000000");
  });

  integrationTest("every finalization leaves a ledger entry and an outbox event", async () => {
    if (!sql) throw new Error("Integration database unavailable");

    const [audit] = await sql<{ ledger_count: number; job_count: number }[]>`
      SELECT
        (
          SELECT count(*)::integer
          FROM billing_ledger_entries
          WHERE account_id = ${accountId}::uuid
        ) AS ledger_count,
        (
          SELECT count(*)::integer
          FROM request_event_outbox
          WHERE payload->>'account_id' = ${accountId}::text
        ) AS job_count
    `;
    expect(audit?.ledger_count).toBe(3);
    expect(audit?.job_count).toBe(3);
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
    if (!engine) throw new Error("Integration database unavailable");

    // secondRequestId was released above; a retry must not dispatch against it.
    await expect(
      engine.reserve({
        requestId: secondRequestId,
        accountId,
        provider: "openrouter",
        estimatedCostUsd: Usd.parse("0.2"),
      }),
    ).rejects.toBeInstanceOf(InvalidReservationStateError);
  });

  integrationTest(
    "finalizes a reservation the expiry sweeper released, funding it from current windows",
    async () => {
      if (!engine || !sql) throw new Error("Integration database unavailable");

      const lateAccountId = crypto.randomUUID();
      createdAccountIds.push(lateAccountId);
      await sql`
        INSERT INTO billing_accounts (id, owner_type, owner_id)
        VALUES (${lateAccountId}::uuid, 'user', ${crypto.randomUUID()}::uuid)
      `;
      await sql`
        INSERT INTO billing_funding_policies (account_id, name, cadence, amount_usd)
        VALUES (${lateAccountId}::uuid, 'Late allowance', 'day', 1)
      `;
      await sql`
        INSERT INTO billing_limit_policies (account_id, name, cadence, limit_usd)
        VALUES (${lateAccountId}::uuid, 'Late limit', 'day', 0.8)
      `;

      // A long request: reserved, swept by expiry, then settled after all.
      const requestId = crypto.randomUUID();
      await engine.reserve({
        requestId,
        accountId: lateAccountId,
        provider: "openrouter",
        estimatedCostUsd: Usd.parse("0.2"),
      });
      expect((await engine.release(requestId)).state).toBe("released");

      const pending = await engine.markPendingReconciliation(requestId, "stream outlived hold");
      expect(pending.state).toBe("pending_reconciliation");

      const finalized = await engine.finalize({
        requestId,
        actualCostUsd: Usd.parse("0.3"),
        usageSource: "reconciled",
        providerRequestId: `gen-integration-late-${runId}`,
      });
      expect(finalized.state).toBe("finalized");
      expect(finalized.actualCostUsd).toBe("0.300000000000");
      expect(finalized.unfundedCostUsd).toBe("0.000000000000");

      const [ledger] = await sql<{ amount_usd: string }[]>`
        SELECT amount_usd::text FROM billing_ledger_entries
        WHERE account_id = ${lateAccountId}::uuid AND category = 'usage'
      `;
      expect(ledger?.amount_usd).toBe("0.300000000000");

      const [window] = await sql<{ reserved_usd: string; committed_usd: string }[]>`
        SELECT reserved_usd::text, committed_usd::text FROM billing_funding_windows
        WHERE account_id = ${lateAccountId}::uuid
      `;
      expect(window?.reserved_usd).toBe("0.000000000000");
      expect(window?.committed_usd).toBe("0.300000000000");

      const [limit] = await sql<{ reserved_usd: string; committed_usd: string }[]>`
        SELECT reserved_usd::text, committed_usd::text FROM billing_limit_windows
        WHERE account_id = ${lateAccountId}::uuid
      `;
      expect(limit?.reserved_usd).toBe("0.000000000000");
      expect(limit?.committed_usd).toBe("0.300000000000");
    },
  );

  integrationTest(
    "serializes concurrent reservations so funding cannot be overspent",
    async () => {
      if (!engine || !sql) throw new Error("Integration database unavailable");

      const concurrencyAccountId = crypto.randomUUID();
      createdAccountIds.push(concurrencyAccountId);
      await sql`
        INSERT INTO billing_accounts (id, owner_type, owner_id)
        VALUES (
          ${concurrencyAccountId}::uuid,
          'user',
          ${crypto.randomUUID()}::uuid
        )
      `;
      await sql`
        INSERT INTO billing_funding_policies (
          account_id,
          name,
          cadence,
          amount_usd
        )
        VALUES (
          ${concurrencyAccountId}::uuid,
          'Concurrency allowance',
          'day',
          1
        )
      `;

      const attempts = await Promise.allSettled([
        engine.reserve({
          requestId: crypto.randomUUID(),
          accountId: concurrencyAccountId,
          provider: "openrouter",
          estimatedCostUsd: Usd.parse("0.75"),
        }),
        engine.reserve({
          requestId: crypto.randomUUID(),
          accountId: concurrencyAccountId,
          provider: "openrouter",
          estimatedCostUsd: Usd.parse("0.75"),
        }),
      ]);

      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(
        1,
      );

      const [funding] = await sql<
        { reserved_usd: string; committed_usd: string }[]
      >`
        SELECT reserved_usd::text, committed_usd::text
        FROM billing_funding_windows
        WHERE account_id = ${concurrencyAccountId}::uuid
      `;
      expect(funding?.reserved_usd).toBe("0.750000000000");
      expect(funding?.committed_usd).toBe("0.000000000000");
    },
  );
});
