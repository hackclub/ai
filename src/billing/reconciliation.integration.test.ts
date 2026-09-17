import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../analytics/worker";
import { BillingEngine } from "./engine";
import { Usd } from "./money";
import { expireStaleReservations, reconcilePendingReservations } from "./reconciliation";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const runId = crypto.randomUUID().slice(0, 8);

describe("reconciliation with PostgreSQL", () => {
  let sql: Sql | undefined;
  let engine: BillingEngine | undefined;
  const accountId = crypto.randomUUID();

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 4 });
    engine = new BillingEngine(sql);
    await migrateJobQueue(databaseUrl);
    await sql`
      INSERT INTO billing_accounts (id, owner_type, owner_id)
      VALUES (${accountId}::uuid, 'user', ${crypto.randomUUID()}::uuid)
    `;
    await sql`
      INSERT INTO billing_funding_policies (account_id, name, cadence, amount_usd, priority)
      VALUES (${accountId}::uuid, 'Reconcile test allowance', 'day', 1, 100)
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`
      SELECT graphile_worker.complete_jobs(ARRAY(
        SELECT id FROM graphile_worker._private_jobs
        WHERE payload->>'account_id' = ${accountId}
      ))
    `;
    const reservations = sql`
      SELECT id FROM billing_reservations WHERE account_id = ${accountId}::uuid
    `;
    await sql`DELETE FROM billing_ledger_entries WHERE account_id = ${accountId}::uuid`;
    for (const table of [
      "billing_reservation_funding_holds",
      "billing_reservation_credit_holds",
      "billing_reservation_limit_holds",
    ]) {
      await sql`DELETE FROM ${sql(table)} WHERE reservation_id IN (${reservations})`;
    }
    await sql`DELETE FROM billing_reservations WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_windows WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_policies WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_accounts WHERE id = ${accountId}::uuid`;
    await sql.end();
  });

  integrationTest("finalizes a pending reservation from the provider record", async () => {
    if (!sql || !engine) throw new Error("Missing database");
    const requestId = crypto.randomUUID();
    const generationId = `gen-reconcile-${runId}`;
    await engine.reserve({
      requestId,
      accountId,
      provider: "openrouter",
      estimatedCostUsd: Usd.parse("0.01"),
    });
    await engine.markPendingReconciliation(requestId, "client disconnected", generationId);

    const result = await reconcilePendingReservations({
      sql,
      billing: engine,
      openRouter: {
        apiKey: "key",
        baseUrl: "https://upstream.test/api",
        fetch: (async (input) => {
          expect(String(input)).toBe(
            `https://upstream.test/api/v1/generation?id=${generationId}`,
          );
          return Response.json({
            data: {
              id: generationId,
              model: "test/model",
              total_cost: 0.0025,
              native_tokens_prompt: 10,
              native_tokens_completion: 20,
            },
          });
        }) as typeof fetch,
      },
    });
    expect(result.finalized).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const [row] = await sql<{ state: string; actual_cost_usd: string; usage_source: string }[]>`
      SELECT state, actual_cost_usd::text, usage_source
      FROM billing_reservations WHERE request_id = ${requestId}::uuid
    `;
    expect(row).toEqual({
      state: "finalized",
      actual_cost_usd: "0.002500000000",
      usage_source: "reconciled",
    });

    const [reservation] = await sql<{ id: string }[]>`
      SELECT id FROM billing_reservations WHERE request_id = ${requestId}::uuid
    `;
    const [job] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM graphile_worker._private_jobs
      WHERE payload->>'reservation_id' = ${reservation?.id ?? ""}
    `;
    expect(job?.payload.outcome).toBe("reconciled");
    expect(job?.payload.input_tokens).toBe(10);
    expect(job?.payload.usage_source).toBe("reconciled");

    // A second pass finds nothing to do for this reservation.
    const again = await reconcilePendingReservations({
      sql,
      billing: engine,
      openRouter: { apiKey: "key", baseUrl: "https://upstream.test/api" },
    });
    expect(again.failed).toBe(0);
  });

  integrationTest("releases reservations that expired without settlement", async () => {
    if (!sql || !engine) throw new Error("Missing database");
    const requestId = crypto.randomUUID();
    await engine.reserve({
      requestId,
      accountId,
      provider: "openrouter",
      estimatedCostUsd: Usd.parse("0.01"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await sql`
      UPDATE billing_reservations SET expires_at = now() - INTERVAL '1 minute'
      WHERE request_id = ${requestId}::uuid
    `;

    const result = await expireStaleReservations({ sql, billing: engine });
    expect(result.released).toBeGreaterThanOrEqual(1);
    const [row] = await sql<{ state: string }[]>`
      SELECT state FROM billing_reservations WHERE request_id = ${requestId}::uuid
    `;
    expect(row?.state).toBe("released");
  });
});
