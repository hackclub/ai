import { describe, expect, test } from "bun:test";

import { hackClubAuthRoutes, type HackClubIdentity } from "./hackclub";
import { SESSION_COOKIE, cookieValue, sessionUser } from "./sessions";
import { testDatabase } from "../test/database";

const { sql } = await testDatabase();

describe("Hack Club OAuth with PostgreSQL", () => {
  const slackId = "U-oauth";
  const identity: HackClubIdentity = {
    id: "hc-1",
    slack_id: slackId,
    primary_email: "user@example.com",
    first_name: "Test",
    last_name: "User",
    verification_status: "verified",
    ysws_eligible: true,
  };
  const tokenRequests: string[] = [];

  const routes = () =>
    hackClubAuthRoutes({
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

  test("callback creates the user with funding and a session", async () => {
    const app = routes();
    const callback = (code: string, state: string) =>
      app.handle(
        new Request(`http://gateway.test/auth/callback?code=${code}&state=${state}`, {
          headers: { cookie: `oauth_state=${state}` },
        }),
      );
    const response = await callback("the-code", "s1");
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
    expect(user?.avatar).toBe(`https://cachet.hackclub.com/users/${slackId}/r`);
    expect(user?.isIdvVerified).toBeTrue();

    const [policy] = await sql<{ amount_usd: string }[]>`
      SELECT amount_usd::text FROM billing_funding_policies
      WHERE account_id = ${user?.billingAccountId ?? ""}::uuid
    `;
    expect(policy?.amount_usd).toBe("3.000000000000");

    // Signing in again updates rather than duplicates.
    expect((await callback("c2", "s2")).status).toBe(302);
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
