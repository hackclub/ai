import { afterAll, beforeAll, describe, expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../analytics/worker";
import { BillingEngine } from "../billing/engine";
import { Usd } from "../billing/money";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { integrationDatabaseUrl, integrationTestFor } from "../test/integration-db";
import { type MeteredRequestAnalytics, runMeteredRequest } from "./metered-request";

const databaseUrl = integrationDatabaseUrl("BILLING_TEST_DATABASE_URL");
const integrationTest = integrationTestFor(databaseUrl);

const encoder = new TextEncoder();
const runId = crypto.randomUUID().slice(0, 8);
const chunkedBody = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
  });

describe("runMeteredRequest with PostgreSQL and OpenRouterAdapter", () => {
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
      INSERT INTO billing_funding_policies (
        account_id, name, cadence, amount_usd, priority
      )
      VALUES (${accountId}::uuid, 'Gateway test allowance', 'day', 1, 100)
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    const reservations = sql`
      SELECT id FROM billing_reservations WHERE account_id = ${accountId}::uuid
    `;
    await sql`
      DELETE FROM request_event_outbox
      WHERE payload->>'account_id' = ${accountId}
    `;
    await sql`DELETE FROM billing_ledger_entries WHERE account_id = ${accountId}::uuid`;
    for (const table of [
      "billing_reservation_funding_holds",
      "billing_reservation_credit_holds",
      "billing_reservation_limit_holds",
    ]) {
      await sql`
        DELETE FROM ${sql(table)} WHERE reservation_id IN (${reservations})
      `;
    }
    await sql`DELETE FROM billing_reservations WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_windows WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_policies WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_accounts WHERE id = ${accountId}::uuid`;
    await sql.end();
  });

  /** Runs a streamed chat completion through the real engine against a canned upstream body. */
  const meterStream = (parts: string[], analytics?: MeteredRequestAnalytics) => {
    if (!engine) throw new Error("Missing database");
    const adapter = new OpenRouterAdapter({
      fetch: async () =>
        new Response(chunkedBody(parts), { headers: { "content-type": "text/event-stream" } }),
    });
    const requestId = crypto.randomUUID();
    const request = runMeteredRequest(engine, {
      requestId,
      accountId,
      provider: "openrouter",
      endpoint: "chat/completions",
      model: "test/model",
      estimatedCostUsd: Usd.parse("0.01"),
      analytics,
      execute: () =>
        adapter.execute({
          endpoint: "chat/completions",
          body: { model: "test/model", stream: true },
          apiKey: "secret",
        }),
    });
    return { requestId, request };
  };

  integrationTest("streams a completion and finalizes with the full body in the outbox event", async () => {
    if (!sql) throw new Error("Missing database");
    const wireBody =
      `data: {"id":"gen-int-${runId}","choices":[{"delta":{"content":"six seven"}}]}\r\n\r\n` +
      `data: {"id":"gen-int-${runId}","choices":[{"delta":{"content":" mango"}}],` +
      '"usage":{"prompt_tokens":4,"completion_tokens":3,"cost":0.0007}}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const request = await meterStream([wireBody.slice(0, 30), wireBody.slice(30)], {
      requestHeaders: {
        authorization: "Bearer secret",
        "x-client": "dropped: not on the allow-list",
        "x-title": "t",
      },
    }).request;

    expect(request.reservation.state).toBe("reserved");
    expect(await request.response.text()).toBe(wireBody);

    const outcome = await request.settled;
    expect(outcome.kind).toBe("finalized");
    expect(outcome.reservation).toMatchObject({
      actualCostUsd: "0.000700000000",
      providerRequestId: `gen-int-${runId}`,
    });

    const [event] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM request_event_outbox
      WHERE payload->>'reservation_id' = ${outcome.reservation.id}
    `;
    expect(event?.payload).toMatchObject({
      outcome: "completed",
      streamed: true,
      input_tokens: 4,
      output_tokens: 3,
      response_body: wireBody,
      request_headers: { "x-title": "t" },
    });
  });

  integrationTest("holds a cancelled stream pending reconciliation", async () => {
    if (!sql) throw new Error("Missing database");
    const { requestId, request: pending } = meterStream([
      `data: {"id":"gen-cancel-${runId}","choices":[]}\n\n`,
      "data: never\n\n",
    ]);
    const request = await pending;
    const reader = request.response.body?.getReader();
    await reader?.read();
    await reader?.cancel("client disconnected");

    const outcome = await request.settled;
    expect(outcome.kind).toBe("pending_reconciliation");
    expect(outcome.reservation.providerRequestId).toBe(`gen-cancel-${runId}`);

    const [row] = await sql<{ state: string; reconciliation_reason: string }[]>`
      SELECT state, reconciliation_reason FROM billing_reservations
      WHERE request_id = ${requestId}::uuid
    `;
    expect(row).toMatchObject({ state: "pending_reconciliation", reconciliation_reason: "client disconnected" });
  });
});
