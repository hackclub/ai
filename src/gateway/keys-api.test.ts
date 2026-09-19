import { describe, expect, test } from "bun:test";
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

/** A fake `sql` tagged template that returns the session row for any query, counting calls. */
const fakeSql = () => {
  let calls = 0;
  const sql = (async () => {
    calls++;
    return [sessionRow];
  }) as unknown as postgres.Sql;
  return { sql, calls: () => calls };
};

describe("keysApiRoutes origin check", () => {
  test("POST with a matching origin succeeds", async () => {
    const { sql } = fakeSql();
    const app = keysApiRoutes({ sql, baseUrl: BASE_URL, secureCookies: false });
    const response = await app.handle(
      new Request(`${BASE_URL}/api/dismiss-agent-banner`, {
        method: "POST",
        headers: { cookie: "session_token=abc", origin: BASE_URL },
      }),
    );
    expect(response.status).toBe(204);
  });

  test("POST with a foreign origin is rejected before the session lookup", async () => {
    const { sql, calls } = fakeSql();
    const app = keysApiRoutes({ sql, baseUrl: BASE_URL, secureCookies: false });
    const response = await app.handle(
      new Request(`${BASE_URL}/api/dismiss-agent-banner`, {
        method: "POST",
        headers: { cookie: "session_token=abc", origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect(calls()).toBe(0);
  });

  test("POST with sec-fetch-site cross-site is rejected before the session lookup", async () => {
    const { sql, calls } = fakeSql();
    const app = keysApiRoutes({ sql, baseUrl: BASE_URL, secureCookies: false });
    const response = await app.handle(
      new Request(`${BASE_URL}/api/dismiss-agent-banner`, {
        method: "POST",
        headers: { cookie: "session_token=abc", "sec-fetch-site": "cross-site" },
      }),
    );
    expect(response.status).toBe(403);
    expect(calls()).toBe(0);
  });

  test("POST with no origin headers succeeds", async () => {
    const { sql } = fakeSql();
    const app = keysApiRoutes({ sql, baseUrl: BASE_URL, secureCookies: false });
    const response = await app.handle(
      new Request(`${BASE_URL}/api/dismiss-agent-banner`, {
        method: "POST",
        headers: { cookie: "session_token=abc" },
      }),
    );
    expect(response.status).toBe(204);
  });

  test("GET with a foreign origin succeeds (safe method)", async () => {
    const { sql } = fakeSql();
    const app = keysApiRoutes({ sql, baseUrl: BASE_URL, secureCookies: false });
    const response = await app.handle(
      new Request(`${BASE_URL}/api/keys`, {
        method: "GET",
        headers: { cookie: "session_token=abc", origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(200);
  });
});
