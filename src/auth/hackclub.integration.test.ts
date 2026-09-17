import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { hackClubAuthRoutes, type HackClubIdentity } from "./hackclub";
import { SESSION_COOKIE, cookieValue, sessionUser } from "./sessions";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const runId = crypto.randomUUID().slice(0, 8);

describe("Hack Club OAuth with PostgreSQL", () => {
  let sql: Sql | undefined;
  const slackId = `U-oauth-${runId}`;
  const identity: HackClubIdentity = {
    id: "hc-1",
    slack_id: slackId,
    primary_email: "user@example.com",
    first_name: "Test",
    last_name: "User",
    verification_status: "verified",
    ysws_eligible: true,
    addresses: [{ country: "US", primary: true }],
  };
  const tokenRequests: string[] = [];

  const routes = () => {
    if (!sql) throw new Error("Missing database");
    return hackClubAuthRoutes({
      sql,
      clientId: "client",
      clientSecret: "secret",
      baseUrl: "http://gateway.test",
      secureCookies: false,
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/oauth/token")) {
          tokenRequests.push(String(init?.body));
          return Response.json({ access_token: "access" });
        }
        if (url.endsWith("/api/v1/me")) {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
          return Response.json({ identity });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }) as typeof fetch,
    });
  };

  beforeAll(() => {
    if (databaseUrl) sql = postgres(databaseUrl, { max: 2 });
  });

  afterAll(async () => {
    if (!sql) return;
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE slack_id = ${slackId}`;
    if (user) {
      await sql`DELETE FROM billing_funding_policies WHERE account_id IN (SELECT id FROM billing_accounts WHERE owner_id = ${user.id}::uuid)`;
      await sql`DELETE FROM billing_accounts WHERE owner_type = 'user' AND owner_id = ${user.id}::uuid`;
      await sql`DELETE FROM users WHERE id = ${user.id}::uuid`;
    }
    await sql.end();
  });

  integrationTest("callback creates the user with funding and a session", async () => {
    if (!sql) throw new Error("Missing database");
    const app = routes();
    const response = await app.handle(
      new Request("http://gateway.test/auth/callback?code=the-code&state=s1", {
        headers: { cookie: "oauth_state=s1" },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(tokenRequests[0]).toContain("code=the-code");

    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookie).toContain("HttpOnly");
    const token = cookieValue(sessionCookie ?? null, SESSION_COOKIE);
    const user = await sessionUser(sql, token);
    expect(user?.slackId).toBe(slackId);
    expect(user?.name).toBe("Test User");
    expect(user?.isIdvVerified).toBeTrue();

    const [policy] = await sql<{ amount_usd: string }[]>`
      SELECT amount_usd::text FROM billing_funding_policies
      WHERE account_id = ${user?.billingAccountId ?? ""}::uuid
    `;
    expect(policy?.amount_usd).toBe("3.000000000000");

    // Signing in again updates rather than duplicates.
    const again = await app.handle(
      new Request("http://gateway.test/auth/callback?code=c2&state=s2", {
        headers: { cookie: "oauth_state=s2" },
      }),
    );
    expect(again.status).toBe(302);
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM users WHERE slack_id = ${slackId}
    `;
    expect(count?.count).toBe(1);

    // Logout clears the session.
    const logout = await app.handle(
      new Request("http://gateway.test/auth/logout", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(logout.status).toBe(302);
    expect(await sessionUser(sql, token)).toBeNull();
  });
});
