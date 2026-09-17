import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../analytics/worker";
import { BillingEngine } from "../billing/engine";
import { Usd } from "../billing/money";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { runMeteredRequest } from "./metered-request";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;

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
      SELECT graphile_worker.complete_jobs(ARRAY(
        SELECT id FROM graphile_worker._private_jobs
        WHERE payload->>'account_id' = ${accountId}
      ))
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

  integrationTest(
    "streams a completion and finalizes with the full body in the analytics job",
    async () => {
      if (!sql || !engine) throw new Error("Missing database");
      const requestId = crypto.randomUUID();
      const wireBody =
        `data: {"id":"gen-int-${runId}","choices":[{"delta":{"content":"six seven"}}]}\r\n\r\n` +
        `data: {"id":"gen-int-${runId}","choices":[{"delta":{"content":" mango"}}],` +
        '"usage":{"prompt_tokens":4,"completion_tokens":3,"cost":0.0007}}\r\n\r\n' +
        "data: [DONE]\r\n\r\n";
      const adapter = new OpenRouterAdapter({
        fetch: async () =>
          new Response(chunkedBody([wireBody.slice(0, 30), wireBody.slice(30)]), {
            headers: { "content-type": "text/event-stream" },
          }),
      });

      const request = await runMeteredRequest(engine, {
        requestId,
        accountId,
        provider: "openrouter",
        endpoint: "chat/completions",
        model: "test/model",
        estimatedCostUsd: Usd.parse("0.01"),
        analytics: {
          requestHeaders: { authorization: "Bearer secret", "x-client": "t" },
        },
        execute: () =>
          adapter.execute({
            endpoint: "chat/completions",
            body: { model: "test/model", stream: true },
            apiKey: "secret",
          }),
      });

      expect(request.reservation.state).toBe("reserved");
      expect(await request.response.text()).toBe(wireBody);

      const outcome = await request.settled;
      expect(outcome.kind).toBe("finalized");
      expect(outcome.reservation.actualCostUsd).toBe("0.000700000000");
      expect(outcome.reservation.providerRequestId).toBe(`gen-int-${runId}`);

      const [event] = await sql<{ payload: Record<string, unknown> }[]>`
        SELECT payload FROM graphile_worker._private_jobs
        WHERE payload->>'reservation_id' = ${outcome.reservation.id}
      `;
      expect(event?.payload.outcome).toBe("completed");
      expect(event?.payload.streamed).toBeTrue();
      expect(event?.payload.input_tokens).toBe(4);
      expect(event?.payload.output_tokens).toBe(3);
      expect(event?.payload.response_body).toBe(wireBody);
      expect(event?.payload.request_headers).toEqual({ "x-client": "t" });
    },
  );

  integrationTest(
    "holds a cancelled stream pending reconciliation",
    async () => {
      if (!sql || !engine) throw new Error("Missing database");
      const requestId = crypto.randomUUID();
      const adapter = new OpenRouterAdapter({
        fetch: async () =>
          new Response(
            chunkedBody([
              `data: {"id":"gen-cancel-${runId}","choices":[]}\n\n`,
              "data: never\n\n",
            ]),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });

      const request = await runMeteredRequest(engine, {
        requestId,
        accountId,
        provider: "openrouter",
        endpoint: "chat/completions",
        model: "test/model",
        estimatedCostUsd: Usd.parse("0.01"),
        execute: () =>
          adapter.execute({
            endpoint: "chat/completions",
            body: { model: "test/model", stream: true },
            apiKey: "secret",
          }),
      });

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
      expect(row?.state).toBe("pending_reconciliation");
      expect(row?.reconciliation_reason).toBe("client disconnected");
    },
  );
});
