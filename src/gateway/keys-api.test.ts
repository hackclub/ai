import { expect, test } from "bun:test";
import type postgres from "postgres";

import { keysApiRoutes } from "./keys-api";

const BASE_URL = "http://gateway.test";

const sessionRow = {
  id: "11111111-1111-1111-1111-111111111111",
  slack_id: "U123",
  email: "user@example.com",
  name: "Test User",
  avatar: null,
  is_banned: false,
  is_idv_verified: true,
  skip_idv: false,
  agent_banner_dismissed_at: null,
  billing_account_id: "22222222-2222-2222-2222-222222222222",
};

const dismissBanner = async (headers: Record<string, string>) => {
  let queries = 0;
  const sql = (async () => {
    queries++;
    return [sessionRow];
  }) as unknown as postgres.Sql;
  const response = await keysApiRoutes({ sql, baseUrl: BASE_URL, secureCookies: false }).handle(
    new Request(`${BASE_URL}/api/dismiss-agent-banner`, {
      method: "POST",
      headers: { cookie: "session_token=abc", ...headers },
    }),
  );
  return { status: response.status, queries };
};

test("POST with a matching origin succeeds", async () => {
  expect((await dismissBanner({ origin: BASE_URL })).status).toBe(204);
});

test.each([
  ["a foreign origin", { origin: "https://evil.example" }],
  ["sec-fetch-site cross-site", { "sec-fetch-site": "cross-site" }],
])("POST with %s is rejected before the session lookup", async (_, headers) => {
  expect(await dismissBanner(headers)).toEqual({ status: 403, queries: 0 });
});
