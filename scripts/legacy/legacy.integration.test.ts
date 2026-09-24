import { beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { authenticateApiKey } from "../../src/auth/api-keys";
import { testClickHouse, testDatabase } from "../../src/test/database";
import { importEvents, legacyProvider } from "./events";
import { importIdentity } from "./identity";

const { sql } = await testDatabase();
const { clickhouse } = await testClickHouse();
const legacyDb = await testDatabase({ empty: true });
const legacy = postgres(legacyDb.url, { max: 2, onnotice: () => {}, connection: { TimeZone: "UTC" } });

// The previous gateway's schema (~/ai/drizzle), reduced to the columns read.
await legacy.unsafe(`
  CREATE TABLE users (
    id uuid PRIMARY KEY, slack_id text NOT NULL, email text, name text, avatar text,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
    is_idv_verified boolean NOT NULL DEFAULT false, skip_idv boolean NOT NULL DEFAULT false,
    is_banned boolean NOT NULL DEFAULT false, spending_limit_usd numeric(10,8) DEFAULT 3,
    agent_banner_dismissed_at timestamp
  );
  CREATE TABLE api_keys (
    id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key text NOT NULL UNIQUE, name text NOT NULL, created_at timestamp NOT NULL DEFAULT now(),
    revoked_at timestamp, is_unlimited boolean NOT NULL DEFAULT false
  );
  CREATE TABLE request_logs (
    id uuid PRIMARY KEY, api_key_id uuid NOT NULL, user_id uuid NOT NULL, slack_id text NOT NULL,
    model text NOT NULL, prompt_tokens integer NOT NULL DEFAULT 0, completion_tokens integer NOT NULL DEFAULT 0,
    total_tokens integer NOT NULL DEFAULT 0, request text NOT NULL, response text NOT NULL, ip text NOT NULL,
    timestamp timestamp NOT NULL DEFAULT now(), duration integer NOT NULL, headers jsonb,
    cost numeric(10,8) NOT NULL DEFAULT 0
  );
`);

const ALICE = "00000000-0000-4000-8000-00000000000a";
const ALICE_DUP = "00000000-0000-4000-8000-00000000000b";
const BOB = "00000000-0000-4000-8000-00000000000c";
const ALICE_KEY = "sk-hc-v1-alice0000000000000000000000000000000000000000000000000000";
const DUP_KEY = "sk-hc-v1-dup000000000000000000000000000000000000000000000000000000";
const BOB_KEY = "sk-hc-v1-bob000000000000000000000000000000000000000000000000000000";

const seedLegacy = async () => {
  await legacy`TRUNCATE users, api_keys, request_logs CASCADE`;
  await legacy`
    INSERT INTO users (id, slack_id, name, spending_limit_usd, created_at, is_banned) VALUES
      (${ALICE}, 'UALICE', 'Alice', 3, '2026-01-01 00:00:00', false),
      (${ALICE_DUP}, 'UALICE', 'Alice again', 3, '2025-12-01 00:00:00', false),
      (${BOB}, 'UBOB', 'Bob', 5, '2026-02-01 12:00:00', true)
  `;
  await legacy`
    INSERT INTO api_keys (id, user_id, key, name, created_at, revoked_at) VALUES
      ('10000000-0000-4000-8000-000000000001', ${ALICE}, ${ALICE_KEY}, 'laptop', '2026-01-02 00:00:00', NULL),
      ('10000000-0000-4000-8000-000000000002', ${ALICE_DUP}, ${DUP_KEY}, '   ', '2025-12-02 00:00:00', NULL),
      ('10000000-0000-4000-8000-000000000003', ${BOB}, ${BOB_KEY}, 'old', '2026-02-02 00:00:00', '2026-03-01 00:00:00')
  `;
  // Alice (not the older duplicate) is the active account.
  await legacy`
    INSERT INTO request_logs (id, api_key_id, user_id, slack_id, model, prompt_tokens, completion_tokens,
      request, response, ip, timestamp, duration, headers, cost) VALUES
      ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', ${ALICE}, 'UALICE',
       'qwen/qwen3-32b', 10, 20, '{"q":1}', '{"a":1}', '1.2.3.4', '2026-09-20 23:59:59.5', 120,
       '{"user-agent":"sdk","authorization":"Bearer sk-hc-v1-leak"}', 0.00012345),
      ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', ${ALICE}, 'UALICE',
       'exa/search', 0, 0, 'old request', 'old response', '1.2.3.4', '2026-05-01 10:00:00', 80, NULL, 0.005),
      ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000009', ${ALICE}, 'UGONE',
       'mistral-ocr-latest', 0, 0, 'x', 'y', '5.6.7.8', '2026-09-21 00:00:00', 50, NULL, 0.001)
  `;
};

beforeEach(async () => {
  await seedLegacy();
  await sql`TRUNCATE users, billing_accounts CASCADE`;
});

describe("importIdentity", () => {
  test("legacy keys authenticate with a $3/$5 daily allowance and bans preserved", async () => {
    const summary = await importIdentity(legacy, sql);
    expect(summary).toEqual({ users: 2, mergedUsers: 1, apiKeys: 3, createdPolicies: 2 });

    const principal = await authenticateApiKey(sql, `Bearer ${ALICE_KEY}`, { enforceIdv: false });
    expect(principal.userId).toBe(ALICE);

    const policies = await sql<{ slack_id: string; cadence: string; amount_usd: string }[]>`
      SELECT u.slack_id, p.cadence, p.amount_usd::text
      FROM billing_funding_policies p
      JOIN billing_accounts a ON a.id = p.account_id
      JOIN users u ON u.id = a.owner_id
      ORDER BY u.slack_id
    `;
    expect([...policies]).toEqual([
      { slack_id: "UALICE", cadence: "day", amount_usd: "3.000000000000" },
      { slack_id: "UBOB", cadence: "day", amount_usd: "5.000000000000" },
    ]);

    // Bob is banned and his key was revoked.
    expect(authenticateApiKey(sql, `Bearer ${BOB_KEY}`, { enforceIdv: false })).rejects.toMatchObject({
      status: 401,
    });
    const [bob] = await sql<{ is_banned: boolean; created_at: Date }[]>`
      SELECT is_banned, created_at FROM users WHERE id = ${BOB}::uuid
    `;
    expect(bob).toEqual({ is_banned: true, created_at: new Date("2026-02-01T12:00:00Z") });
  });

  test("a duplicate Slack ID merges into the active user and keeps its keys", async () => {
    await importIdentity(legacy, sql);

    const principal = await authenticateApiKey(sql, `Bearer ${DUP_KEY}`, { enforceIdv: false });
    expect(principal.userId).toBe(ALICE);
    const [key] = await sql<{ name: string; key_prefix: string }[]>`
      SELECT name, key_prefix FROM api_keys WHERE id = '10000000-0000-4000-8000-000000000002'
    `;
    expect(key).toEqual({ name: "Imported key", key_prefix: DUP_KEY.slice(0, 16) });
    expect(await sql`SELECT 1 FROM users WHERE id = ${ALICE_DUP}::uuid`).toHaveLength(0);
  });

  test("re-running converges and keeps revocations made on this side", async () => {
    await importIdentity(legacy, sql);
    await sql`UPDATE api_keys SET revoked_at = now() WHERE id = '10000000-0000-4000-8000-000000000001'`;
    await legacy`UPDATE users SET name = 'Alice R.' WHERE id = ${ALICE}`;

    const summary = await importIdentity(legacy, sql);
    expect(summary.createdPolicies).toBe(0);
    expect(await sql`SELECT 1 FROM billing_funding_policies`).toHaveLength(2);
    const [alice] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${ALICE}::uuid`;
    expect(alice?.name).toBe("Alice R.");
    expect(authenticateApiKey(sql, `Bearer ${ALICE_KEY}`, { enforceIdv: false })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("importEvents", () => {
  test("copies logs per UTC day with redacted headers and bodies only after the cutoff", async () => {
    await clickhouse.command({ query: "TRUNCATE TABLE request_events" });
    await importIdentity(legacy, sql);
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM billing_accounts WHERE owner_id = ${ALICE}::uuid
    `;

    const days: string[] = [];
    const result = await importEvents(legacy, sql, clickhouse, {
      from: new Date("2026-05-01T00:00:00Z"),
      to: new Date("2026-09-22T00:00:00Z"),
      bodiesSince: new Date("2026-06-24T00:00:00Z"),
      concurrency: 3,
      onDay: (day, rows) => rows && days.push(`${day.toISOString().slice(0, 10)}:${rows}`),
    });
    expect(result).toEqual({ rows: 3, unattributed: 1 });
    expect(days.toSorted()).toEqual(["2026-05-01:1", "2026-09-20:1", "2026-09-21:1"]);

    const rows = await (
      await clickhouse.query({
        query: `SELECT event_id, account_id, user_id, provider, model, input_tokens, output_tokens,
                  toString(billed_cost_usd) AS cost, toString(occurred_at) AS occurred_at,
                  request_headers, attributes['ip'] AS ip, request_body
                FROM request_events FINAL ORDER BY occurred_at`,
        format: "JSONEachRow",
      })
    ).json<Record<string, unknown>>();

    expect(rows).toEqual([
      expect.objectContaining({
        event_id: "20000000-0000-4000-8000-000000000002",
        provider: "exa",
        cost: "0.005",
        request_body: "",
      }),
      {
        event_id: "20000000-0000-4000-8000-000000000001",
        account_id: account?.id,
        user_id: ALICE,
        provider: "openrouter",
        model: "qwen/qwen3-32b",
        input_tokens: 10,
        output_tokens: 20,
        cost: "0.00012345",
        occurred_at: "2026-09-20 23:59:59.500",
        request_headers: { "user-agent": "sdk" },
        ip: "1.2.3.4",
        request_body: '{"q":1}',
      },
      expect.objectContaining({
        event_id: "20000000-0000-4000-8000-000000000003",
        account_id: "00000000-0000-0000-0000-000000000000",
        user_id: null,
        provider: "mistral",
      }),
    ]);

    // Importing the same range again leaves one row per event.
    await importEvents(legacy, sql, clickhouse, {
      from: new Date("2026-09-20T00:00:00Z"),
      to: new Date("2026-09-22T00:00:00Z"),
      bodiesSince: new Date("2026-06-24T00:00:00Z"),
    });
    const counted = await (
      await clickhouse.query({ query: "SELECT count() AS n FROM request_events FINAL", format: "JSONEachRow" })
    ).json<{ n: number }>();
    expect(counted).toEqual([{ n: 3 }]);
  });

  test("legacyProvider recognises the non-OpenRouter models", () => {
    expect(["exa/answer", "mistral-ocr", "jev/systemone", "openai/gpt-5-mini"].map(legacyProvider)).toEqual([
      "exa",
      "mistral",
      "typesafe",
      "openrouter",
    ]);
  });
});
