import { describe, expect, test } from "bun:test";

import { issueApiKey } from "../auth/api-keys";
import { createUser } from "../auth/users";
import { BillingEngine } from "../billing/engine";
import { Usd } from "../billing/money";
import { reconcilePendingReservations } from "../billing/reconciliation";
import { exaRoutes } from "../gateway/routes/exa";
import { createTestAccount, fakeFetch, post, testBilling } from "../gateway/routes/test-harness";
import { openRouterProvider } from "../providers/openrouter/provider";
import { providerRegistry } from "../providers/provider";
import { testBlobStore, testClickHouse, testDatabase } from "../test/database";
import { toClickHouseEvent } from "./request-event";
import { drainRequestEvents } from "./request-events";

const { sql } = await testDatabase();
const { clickhouse } = await testClickHouse();
const blobStore = await testBlobStore();

/** The request_events row for a request, money rendered by ClickHouse as text. */
const clickHouseRow = async (requestId: string) => {
  await drainRequestEvents({ sql, clickhouse, blobStore, batchSize: 1_000 });
  const result = await clickhouse.query({
    query: `
      SELECT
        *,
        toString(estimated_cost_usd) AS estimated,
        toString(provider_cost_usd) AS provider_cost,
        toString(billed_cost_usd) AS billed,
        toString(unfunded_cost_usd) AS unfunded
      FROM request_events FINAL
      WHERE request_id = {id:UUID}
    `,
    query_params: { id: requestId },
    format: "JSONEachRow",
  });
  const rows = await result.json<Record<string, unknown>>();
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe("the request event from gateway to ClickHouse", () => {
  const { billing, settlements, settled } = testBilling(sql);

  const exaSearch = async (
    account: { apiKey: string },
    upstreamBody: unknown,
    options: { reservationUsd?: string } = {},
  ) => {
    const { fetch } = fakeFetch(() => Response.json(upstreamBody));
    const app = exaRoutes({ sql, billing, settlements, enforceIdv: false, exaApiKey: "k", fetch, ...options });
    const response = await app.handle(
      post("/proxy/v1/exa/search", { query: "six seven mango" }, {
        authorization: `Bearer ${account.apiKey}`,
        "user-agent": "event-test",
        "cf-connecting-ip": "203.0.113.7",
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await settled();
    const requestId = response.headers.get("x-request-id");
    if (!requestId) throw new Error("response has no x-request-id");
    return requestId;
  };

  test("a live request fills every column", async () => {
    const account = await createTestAccount(sql, "event-live");
    const requestId = await exaSearch(account, { requestId: "exa-1", costDollars: { total: 0.004 } });

    const row = await clickHouseRow(requestId);
    const [reservation] = await sql<{ id: string }[]>`
      SELECT id::text FROM billing_reservations WHERE request_id = ${requestId}::uuid
    `;
    expect(row).toMatchObject({
      request_id: requestId,
      reservation_id: reservation!.id,
      account_id: account.accountId,
      user_id: account.userId,
      api_key_id: account.apiKeyId,
      provider: "exa",
      provider_request_id: "exa-1",
      endpoint: "exa/search",
      model: "exa/search",
      outcome: "completed",
      error_code: "",
      http_status: 200,
      streamed: false,
      input_tokens: 0,
      output_tokens: 0,
      estimated: "0.02",
      provider_cost: "0.004",
      billed: "0.004",
      unfunded: "0",
      usage_source: "provider_reported",
      request_headers: { "user-agent": "event-test", "content-type": "application/json" },
      attributes: { ip: "203.0.113.7", body_capture: "complete" },
      request_body: '{"query":"six seven mango"}',
      response_body: '{"requestId":"exa-1","costDollars":{"total":0.004}}',
    });
    expect(row.event_id).toEqual(expect.any(String));
    expect(row.occurred_at).toEqual(expect.any(String));
    expect(row.duration_ms).toEqual(expect.any(Number));
    expect(row.time_to_first_byte_ms).toEqual(expect.any(Number));
    expect((row.response_headers as Record<string, string>)["content-type"]).toContain("application/json");
  });

  test("a charge funding did not cover reaches ClickHouse as unfunded cost", async () => {
    const user = await createUser(sql, { slackId: "U-event-unfunded", dailyAllowanceUsd: "0.001" });
    const { key } = await issueApiKey(sql, user.userId, "unfunded");
    const requestId = await exaSearch(
      { apiKey: key },
      { requestId: "exa-2", costDollars: { total: 0.004 } },
      { reservationUsd: "0.001" },
    );

    const row = await clickHouseRow(requestId);
    const [reservation] = await sql<{ unfunded: string }[]>`
      SELECT unfunded_cost_usd::text AS unfunded FROM billing_reservations WHERE request_id = ${requestId}::uuid
    `;
    expect(reservation!.unfunded).toBe("0.003000000000");
    expect(row.unfunded).toBe("0.003");
    expect(Usd.parse(String(row.unfunded)).equals(Usd.parse(reservation!.unfunded))).toBe(true);
  });

  test("a reconciled request keeps the identity and endpoint recorded at reserve", async () => {
    const account = await createTestAccount(sql, "event-reconciled");
    const engine = new BillingEngine(sql);
    const requestId = crypto.randomUUID();
    const generationId = "gen-event-reconciled";
    await engine.reserve({
      requestId,
      accountId: account.accountId,
      userId: account.userId,
      apiKeyId: account.apiKeyId,
      endpoint: "chat/completions",
      provider: "openrouter",
      estimatedCostUsd: Usd.parse("0.01"),
    });
    await engine.markPendingReconciliation(requestId, "client disconnected", generationId);

    const result = await reconcilePendingReservations({
      sql,
      billing: engine,
      providers: providerRegistry([
        openRouterProvider({
          apiKey: "key",
          baseUrl: "https://upstream.test/api/",
          fetch: (async () =>
            Response.json({
              data: {
                id: generationId,
                model: "test/model",
                total_cost: 0.002,
                native_tokens_prompt: 5,
                native_tokens_completion: 7,
              },
            })) as unknown as typeof fetch,
        }),
      ]),
    });
    expect(result.finalized).toBe(1);

    const row = await clickHouseRow(requestId);
    expect(row).toMatchObject({
      outcome: "reconciled",
      endpoint: "chat/completions",
      model: "test/model",
      user_id: account.userId,
      api_key_id: account.apiKeyId,
      usage_source: "reconciled",
      http_status: 0,
      input_tokens: 5,
      output_tokens: 7,
      billed: "0.002",
      attributes: { body_capture: "none", reconciliation_reason: "client disconnected" },
    });
  });
});

describe("toClickHouseEvent", () => {
  test("maps a finalization payload and defaults malformed fields", () => {
    const row = toClickHouseEvent({
      event_id: "11111111-1111-1111-1111-111111111111",
      occurred_at: "2026-09-17T12:00:00.250Z",
      request_id: "22222222-2222-2222-2222-222222222222",
      account_id: "33333333-3333-3333-3333-333333333333",
      provider: "openrouter",
      streamed: true,
      http_status: "not a number",
      time_to_first_byte_ms: 12,
      request_headers: { "user-agent": "x", nested: { bad: true } },
      billed_cost_usd: "0.000500000000",
    });
    expect(row).toMatchObject({
      occurred_at: "2026-09-17 12:00:00.250",
      http_status: 0,
      time_to_first_byte_ms: 12,
      request_headers: { "user-agent": "x" },
      outcome: "completed",
      provider_cost_usd: null,
      user_id: null,
    });
  });

  test("maps a payload written before unfunded_cost_usd existed", () => {
    const row = toClickHouseEvent({
      event_id: "11111111-1111-1111-1111-111111111111",
      billed_cost_usd: "0.000500000000",
    });
    expect(row.unfunded_cost_usd).toBe("0");
  });

  test("refuses a payload that is not an object", () => {
    expect(() => toClickHouseEvent("event")).toThrow(TypeError);
    expect(() => toClickHouseEvent(null)).toThrow(TypeError);
    expect(() => toClickHouseEvent([])).toThrow(TypeError);
  });
});
