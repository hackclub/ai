import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { drainRequestEvents, MAX_DELIVERY_ATTEMPTS, stripParkedBodies } from "./request-events";

const databaseUrl = process.env.ANALYTICS_TEST_DATABASE_URL;
const clickhouseUrl = process.env.ANALYTICS_TEST_CLICKHOUSE_URL;
const integrationTest = databaseUrl && clickhouseUrl ? test : test.skip;

describe("request event delivery with PostgreSQL and ClickHouse", () => {
  let sql: Sql | undefined;
  let clickhouse: ClickHouseClient | undefined;
  let eventId: string;
  let accountId: string;

  beforeAll(async () => {
    if (!databaseUrl || !clickhouseUrl) return;

    sql = postgres(databaseUrl);
    clickhouse = createClient({
      url: clickhouseUrl,
      username: process.env.CLICKHOUSE_USER ?? "hcai",
      password: process.env.CLICKHOUSE_PASSWORD ?? "hcai",
    });
    eventId = crypto.randomUUID();
    accountId = crypto.randomUUID();

    await sql`
      INSERT INTO request_event_outbox (payload)
      VALUES (
        ${sql.json({
          event_id: eventId,
          occurred_at: new Date().toISOString(),
          request_id: crypto.randomUUID(),
          account_id: accountId,
          provider: "openrouter",
          endpoint: "chat/completions",
          model: "test/model",
          http_status: 200,
          input_tokens: 3,
          output_tokens: 4,
          estimated_cost_usd: "0.001000000000",
          billed_cost_usd: "0.000500000000",
          usage_source: "provider_reported",
          request_body: '{"prompt":"six seven mango"}',
          response_body: '{"answer":"six seven mango"}',
        })}::jsonb
      ),
      (${sql.json({ account_id: accountId, note: "no event id" })}::jsonb)
    `;
  });

  afterAll(async () => {
    if (sql) {
      await sql`
        DELETE FROM request_event_outbox
        WHERE payload->>'account_id' = ${accountId}
      `;
      await sql.end();
    }
    if (clickhouse && eventId) {
      await clickhouse.command({
        query: `DELETE FROM hcai.request_events WHERE event_id = {event_id:UUID}`,
        query_params: { event_id: eventId },
      });
      await clickhouse.close();
    }
  });

  integrationTest(
    "delivers complete searchable bodies, deletes the row, and parks an unmappable one",
    async () => {
      if (!sql || !clickhouse) {
        throw new Error("Integration datastores unavailable");
      }

      // Every row the outbox holds is taken; other tests' rows are delivered too.
      await drainRequestEvents({ sql, clickhouse, batchSize: 1_000 });

      const result = await clickhouse.query({
        query: `
          SELECT request_body, response_body
          FROM hcai.request_events
          WHERE
            event_id = {event_id:UUID}
            AND hasAllTokens(request_body, 'six seven mango')
            AND positionCaseInsensitiveUTF8(request_body, 'six seven mango') > 0
        `,
        query_params: { event_id: eventId },
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([
        {
          request_body: '{"prompt":"six seven mango"}',
          response_body: '{"answer":"six seven mango"}',
        },
      ]);

      const remaining = await sql<{ attempts: number; last_error: string | null }[]>`
        SELECT attempts, last_error
        FROM request_event_outbox
        WHERE payload->>'account_id' = ${accountId}
      `;
      expect([...remaining]).toEqual([
        {
          attempts: MAX_DELIVERY_ATTEMPTS,
          last_error: "request event payload has no event_id",
        },
      ]);
    },
  );

  integrationTest(
    "redelivers a row whose claim lease expired but leaves a freshly claimed one alone",
    async () => {
      if (!sql || !clickhouse) {
        throw new Error("Integration datastores unavailable");
      }

      const expiredEventId = crypto.randomUUID();
      const freshEventId = crypto.randomUUID();
      const basePayload = (id: string) => ({
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
      });

      await sql`
        INSERT INTO request_event_outbox (payload, claimed_at)
        VALUES (
          ${sql.json(basePayload(expiredEventId))}::jsonb,
          now() - INTERVAL '10 minutes'
        )
      `;
      const [{ id: freshId, claimed_at: freshClaimedAt }] = await sql<
        { id: string; claimed_at: Date }[]
      >`
        INSERT INTO request_event_outbox (payload, claimed_at)
        VALUES (${sql.json(basePayload(freshEventId))}::jsonb, now())
        RETURNING id::text, claimed_at
      `;

      await drainRequestEvents({ sql, clickhouse, batchSize: 1_000 });

      const expiredRemaining = await sql<{ id: string }[]>`
        SELECT id::text FROM request_event_outbox
        WHERE payload->>'event_id' = ${expiredEventId}
      `;
      expect(expiredRemaining).toHaveLength(0);

      const freshRow = await sql<{ claimed_at: Date }[]>`
        SELECT claimed_at FROM request_event_outbox WHERE id = ${freshId}::bigint
      `;
      expect(freshRow).toHaveLength(1);
      expect(freshRow[0]?.claimed_at?.toISOString()).toBe(freshClaimedAt.toISOString());

      await sql`DELETE FROM request_event_outbox WHERE id = ${freshId}::bigint`;
      await clickhouse.command({
        query: `DELETE FROM hcai.request_events WHERE event_id = {event_id:UUID}`,
        query_params: { event_id: expiredEventId },
      });
    },
  );

  integrationTest(
    "releases the claim and counts an attempt when the ClickHouse insert fails",
    async () => {
      if (!sql) {
        throw new Error("Integration datastores unavailable");
      }

      const failingEventId = crypto.randomUUID();
      await sql`
        INSERT INTO request_event_outbox (payload)
        VALUES (
          ${sql.json({
            event_id: failingEventId,
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
          })}::jsonb
        )
      `;

      const failingClickhouse = {
        insert: async () => {
          throw new Error("boom");
        },
      } as unknown as ClickHouseClient;

      await expect(
        drainRequestEvents({ sql, clickhouse: failingClickhouse, batchSize: 1_000 }),
      ).rejects.toThrow("boom");

      const [row] = await sql<
        { attempts: number; claimed_at: Date | null; last_error: string | null }[]
      >`
        SELECT attempts, claimed_at, last_error
        FROM request_event_outbox
        WHERE payload->>'event_id' = ${failingEventId}
      `;
      expect(row?.attempts).toBe(1);
      expect(row?.claimed_at).toBeNull();
      expect(row?.last_error).toBe("boom");

      await sql`DELETE FROM request_event_outbox WHERE payload->>'event_id' = ${failingEventId}`;
    },
  );

  integrationTest(
    "strips request/response bodies from parked rows older than the retention window",
    async () => {
      if (!sql) {
        throw new Error("Integration datastores unavailable");
      }

      const oldEventId = crypto.randomUUID();
      const recentEventId = crypto.randomUUID();
      const parkedPayload = (id: string) => ({
        event_id: id,
        account_id: accountId,
        request_body: '{"prompt":"parked"}',
        response_body: '{"answer":"parked"}',
      });

      await sql`
        INSERT INTO request_event_outbox (payload, attempts, created_at)
        VALUES (
          ${sql.json(parkedPayload(oldEventId))}::jsonb,
          ${MAX_DELIVERY_ATTEMPTS},
          now() - INTERVAL '8 days'
        )
      `;
      await sql`
        INSERT INTO request_event_outbox (payload, attempts, created_at)
        VALUES (
          ${sql.json(parkedPayload(recentEventId))}::jsonb,
          ${MAX_DELIVERY_ATTEMPTS},
          now() - INTERVAL '1 day'
        )
      `;

      const stripped = await stripParkedBodies(sql);
      expect(stripped).toBe(1);

      const [oldRow] = await sql<
        { has_bodies: boolean; event_id: string }[]
      >`
        SELECT
          (payload ? 'request_body' OR payload ? 'response_body') AS has_bodies,
          payload->>'event_id' AS event_id
        FROM request_event_outbox
        WHERE payload->>'event_id' = ${oldEventId}
      `;
      expect(oldRow?.has_bodies).toBe(false);
      expect(oldRow?.event_id).toBe(oldEventId);

      const [recentRow] = await sql<{ has_bodies: boolean }[]>`
        SELECT (payload ? 'request_body' OR payload ? 'response_body') AS has_bodies
        FROM request_event_outbox
        WHERE payload->>'event_id' = ${recentEventId}
      `;
      expect(recentRow?.has_bodies).toBe(true);

      await sql`
        DELETE FROM request_event_outbox
        WHERE payload->>'event_id' IN (${oldEventId}, ${recentEventId})
      `;
    },
  );
});
