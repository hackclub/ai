import type { ClickHouseClient } from "@clickhouse/client";
import { beforeAll, describe, expect, test } from "bun:test";

import { testClickHouse, testDatabase } from "../test/database";
import { drainRequestEvents, MAX_DELIVERY_ATTEMPTS, stripParkedBodies } from "./request-events";

const { sql } = await testDatabase();
const { clickhouse } = await testClickHouse();

describe("request event delivery with PostgreSQL and ClickHouse", () => {
  const accountId = crypto.randomUUID();
  const eventId = crypto.randomUUID();

  const payload = (id: string, extra: Record<string, string | number> = {}) => ({
    event_id: id,
    occurred_at: new Date().toISOString(),
    request_id: crypto.randomUUID(),
    account_id: accountId,
    provider: "openrouter",
    endpoint: "chat/completions",
    model: "test/model",
    http_status: 200,
    input_tokens: 1,
    output_tokens: 1,
    estimated_cost_usd: "0.001000000000",
    billed_cost_usd: "0.000500000000",
    usage_source: "provider_reported",
    ...extra,
  });

  beforeAll(async () => {
    const body = { request_body: '{"prompt":"six seven mango"}', response_body: '{"answer":"six seven mango"}' };
    await sql`
      INSERT INTO request_event_outbox (payload)
      VALUES
        (${sql.json(payload(eventId, body))}::jsonb),
        (${sql.json({ account_id: accountId, note: "no event id" })}::jsonb)
    `;
  });

  test("delivers complete searchable bodies, deletes the row, and parks an unmappable one", async () => {
    // Every row the outbox holds is taken; other tests' rows are delivered too.
    await drainRequestEvents({ sql, clickhouse, batchSize: 1_000 });

    const result = await clickhouse.query({
      query: `
        SELECT request_body, response_body
        FROM request_events
        WHERE
          event_id = {event_id:UUID}
          AND hasAllTokens(request_body, 'six seven mango')
          AND positionCaseInsensitiveUTF8(request_body, 'six seven mango') > 0
      `,
      query_params: { event_id: eventId },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { request_body: '{"prompt":"six seven mango"}', response_body: '{"answer":"six seven mango"}' },
    ]);

    const remaining = await sql`
      SELECT attempts, last_error FROM request_event_outbox WHERE payload->>'account_id' = ${accountId}
    `;
    expect([...remaining]).toEqual([
      { attempts: MAX_DELIVERY_ATTEMPTS, last_error: "request event payload has no event_id" },
    ]);
  });

  test("redelivers a row whose claim lease expired but leaves a freshly claimed one alone", async () => {
    const expiredEventId = crypto.randomUUID();
    await sql`
      INSERT INTO request_event_outbox (payload, claimed_at)
      VALUES (${sql.json(payload(expiredEventId))}::jsonb, now() - INTERVAL '10 minutes')
    `;
    const [fresh] = await sql<{ id: string; claimed_at: Date }[]>`
      INSERT INTO request_event_outbox (payload, claimed_at)
      VALUES (${sql.json(payload(crypto.randomUUID()))}::jsonb, now())
      RETURNING id::text, claimed_at
    `;

    await drainRequestEvents({ sql, clickhouse, batchSize: 1_000 });

    expect(await sql`SELECT 1 FROM request_event_outbox WHERE payload->>'event_id' = ${expiredEventId}`).toHaveLength(0);
    const freshRow = await sql<{ claimed_at: Date }[]>`
      SELECT claimed_at FROM request_event_outbox WHERE id = ${fresh!.id}::bigint
    `;
    expect(freshRow.map((row) => row.claimed_at.toISOString())).toEqual([fresh!.claimed_at.toISOString()]);
  });

  test("releases the claim and counts an attempt when the ClickHouse insert fails", async () => {
    const failingEventId = crypto.randomUUID();
    await sql`INSERT INTO request_event_outbox (payload) VALUES (${sql.json(payload(failingEventId))}::jsonb)`;

    const failingClickhouse = {
      insert: async () => {
        throw new Error("boom");
      },
    } as unknown as ClickHouseClient;
    await expect(drainRequestEvents({ sql, clickhouse: failingClickhouse, batchSize: 1_000 })).rejects.toThrow("boom");

    const [row] = await sql`
      SELECT attempts, claimed_at, last_error FROM request_event_outbox WHERE payload->>'event_id' = ${failingEventId}
    `;
    expect(row).toEqual({ attempts: 1, claimed_at: null, last_error: "boom" });
  });

  test("strips request/response bodies from parked rows older than the retention window", async () => {
    const oldEventId = crypto.randomUUID();
    const recentEventId = crypto.randomUUID();
    const parked = (id: string) =>
      sql.json({ event_id: id, account_id: accountId, request_body: '{"prompt":"parked"}', response_body: '{"answer":"parked"}' });
    await sql`
      INSERT INTO request_event_outbox (payload, attempts, created_at)
      VALUES
        (${parked(oldEventId)}::jsonb, ${MAX_DELIVERY_ATTEMPTS}, now() - INTERVAL '8 days'),
        (${parked(recentEventId)}::jsonb, ${MAX_DELIVERY_ATTEMPTS}, now() - INTERVAL '1 day')
    `;

    expect(await stripParkedBodies(sql)).toBe(1);

    const rows = await sql<{ event_id: string; has_bodies: boolean }[]>`
      SELECT payload->>'event_id' AS event_id, (payload ? 'request_body' OR payload ? 'response_body') AS has_bodies
      FROM request_event_outbox
      WHERE payload->>'event_id' IN (${oldEventId}, ${recentEventId})
    `;
    expect(Object.fromEntries(rows.map((row) => [row.event_id, row.has_bodies]))).toEqual({
      [oldEventId]: false,
      [recentEventId]: true,
    });
  });
});
