import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runOnce } from "graphile-worker";
import postgres, { type Sql } from "postgres";

import { REQUEST_EVENT_TASK } from "../billing/engine";
import { migrateJobQueue, taskList } from "./worker";

const databaseUrl = process.env.ANALYTICS_TEST_DATABASE_URL;
const clickhouseUrl = process.env.ANALYTICS_TEST_CLICKHOUSE_URL;
const integrationTest = databaseUrl && clickhouseUrl ? test : test.skip;

describe("request event delivery with PostgreSQL and ClickHouse", () => {
  let sql: Sql | undefined;
  let clickhouse: ClickHouseClient | undefined;
  let eventId: string;

  beforeAll(async () => {
    if (!databaseUrl || !clickhouseUrl) return;

    sql = postgres(databaseUrl);
    clickhouse = createClient({
      url: clickhouseUrl,
      username: process.env.CLICKHOUSE_USER ?? "hcai",
      password: process.env.CLICKHOUSE_PASSWORD ?? "hcai",
    });
    eventId = crypto.randomUUID();
    await migrateJobQueue(databaseUrl);

    await sql`
      SELECT graphile_worker.add_job(
        ${REQUEST_EVENT_TASK},
        ${sql.json({
          event_id: eventId,
          occurred_at: new Date().toISOString(),
          request_id: crypto.randomUUID(),
          account_id: crypto.randomUUID(),
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
        })}::json
      )
    `;
  });

  afterAll(async () => {
    if (sql) await sql.end();
    if (clickhouse && eventId) {
      await clickhouse.command({
        query: `DELETE FROM hcai.request_events WHERE event_id = {event_id:UUID}`,
        query_params: { event_id: eventId },
      });
      await clickhouse.close();
    }
  });

  integrationTest(
    "delivers complete searchable bodies and completes the job",
    async () => {
      if (!sql || !clickhouse || !databaseUrl) {
        throw new Error("Integration datastores unavailable");
      }

      await runOnce({
        connectionString: databaseUrl,
        taskList: taskList(clickhouse),
        noHandleSignals: true,
      });

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

      const [remaining] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM graphile_worker._private_jobs
        WHERE payload->>'event_id' = ${eventId}
      `;
      expect(remaining?.count).toBe(0);
    },
  );
});
