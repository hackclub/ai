import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { drainRequestEvents, MAX_DELIVERY_ATTEMPTS } from "./request-events";

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
});
