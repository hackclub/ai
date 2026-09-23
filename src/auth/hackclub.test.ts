import { describe, expect, test } from "bun:test";

import { testDatabase } from "../test/database";
import { hackClubAuthRoutes } from "./hackclub";
import { cookieValue, createSessions } from "./sessions";

const { sql } = await testDatabase();

// These paths never reach Hack Club.
const routes = (secureCookies: boolean) =>
  hackClubAuthRoutes({
    sql,
    clientId: "client",
    clientSecret: "secret",
    baseUrl: "http://gateway.test",
    secureCookies,
    sessions: createSessions({ sql, secureCookies }),
    fetch: (async () => {
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch,
  });

describe("Hack Club OAuth redirects", () => {
  test("login redirects to Hack Club with a state cookie", async () => {
    const response = await routes(false).handle(new Request("http://gateway.test/auth/login"));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://auth.hackclub.com");
    expect(location.searchParams.get("client_id")).toBe("client");
    expect(location.searchParams.get("redirect_uri")).toBe("http://gateway.test/auth/callback");
    const state = location.searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    expect(cookieValue(response.headers.get("set-cookie"), "oauth_state")).toBe(state);
  });

  test("login uses a __Host- prefixed state cookie when secureCookies is true", async () => {
    const response = await routes(true).handle(new Request("http://gateway.test/auth/login"));
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toStartWith("__Host-oauth_state=");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
  });

  test("callback rejects a mismatched state", async () => {
    const response = await routes(false).handle(
      new Request("http://gateway.test/auth/callback?code=c&state=wrong", {
        headers: { cookie: "oauth_state=right" },
      }),
    );
    expect(response.status).toBe(400);
  });
});
