import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import { cookieValue, sessionUser } from "./sessions";

describe("cookieValue", () => {
  test("decodes the named cookie and ignores the rest", () => {
    expect(cookieValue("a=1; session_token=abc%3D%3D; b=2", "session_token")).toBe("abc==");
    expect(cookieValue("a=1", "session_token")).toBeUndefined();
    expect(cookieValue(null, "session_token")).toBeUndefined();
  });

  test("treats a value that is not valid percent-encoding as no cookie", () => {
    // A browser may carry a cookie set by a sibling host; it must not 500 every page.
    expect(cookieValue("session_token=%E0", "session_token")).toBeUndefined();
    expect(cookieValue("session_token=%", "session_token")).toBeUndefined();
  });
});

describe("sessionUser", () => {
  test("returns null without calling sql when token is missing", async () => {
    let calls = 0;
    const sql = (async () => {
      calls++;
      return [];
    }) as unknown as postgres.Sql;
    expect(await sessionUser(sql, undefined)).toBeNull();
    expect(calls).toBe(0);
  });

  test("returns null when no row matches (missing or expired)", async () => {
    const sql = (async () => []) as unknown as postgres.Sql;
    expect(await sessionUser(sql, "token")).toBeNull();
  });

  test("maps a session row to a camelCase SessionUser", async () => {
    const row = {
      id: "u1",
      slack_id: "s1",
      email: "a@b.com",
      name: "Ada",
      avatar: "https://a",
      is_banned: false,
      is_idv_verified: true,
      skip_idv: false,
      agent_banner_dismissed_at: null,
      billing_account_id: "a1",
    };
    const sql = (async () => [row]) as unknown as postgres.Sql;
    expect(await sessionUser(sql, "token")).toEqual({
      id: "u1",
      slackId: "s1",
      email: "a@b.com",
      name: "Ada",
      avatar: "https://a",
      isBanned: false,
      isIdvVerified: true,
      skipIdv: false,
      agentBannerDismissedAt: null,
      billingAccountId: "a1",
    });
  });
});
