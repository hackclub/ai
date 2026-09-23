import { beforeAll, describe, expect, test } from "bun:test";

import { revokeApiKeyByToken } from "../auth/api-keys";
import { createSessions } from "../auth/sessions";
import { BANNED_MESSAGE, createUser } from "../auth/users";
import { testDatabase } from "../test/database";
import { keysApiRoutes } from "./keys-api";
import { webhookRoutes } from "./webhooks";

const { sql } = await testDatabase();

const BASE_URL = "http://gateway.test";
const sessions = createSessions({ sql, secureCookies: false });
const app = keysApiRoutes({ sql, baseUrl: BASE_URL, sessions });

/** A signed-in user's Cookie request header. */
const signIn = async (slackId: string) => {
  const user = await createUser(sql, { slackId });
  return { userId: user.userId, cookie: (await sessions.start(user.userId)).split(";")[0] ?? "" };
};

describe("keys API and revoke webhooks with PostgreSQL", () => {
  let cookie: string;

  beforeAll(async () => {
    ({ cookie } = await signIn("U-keys"));
  });

  const call = (path: string, init: RequestInit = {}, withCookie = cookie) =>
    app.handle(
      new Request(`${BASE_URL}${path}`, {
        ...init,
        headers: { cookie: withCookie, "content-type": "application/json", ...(init.headers ?? {}) },
      }),
    );

  test("requires a session", async () => {
    const response = await app.handle(new Request(`${BASE_URL}/api/keys`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  test("refuses a banned user's valid session", async () => {
    const banned = await signIn("U-keys-banned");
    await sql`UPDATE users SET is_banned = true WHERE id = ${banned.userId}::uuid`;
    const response = await call("/api/keys", {}, banned.cookie);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BANNED_MESSAGE });
  });

  test("creates, lists, revokes, and validates names", async () => {
    const bad = await call("/api/keys", { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(bad.status).toBe(400);

    const created = await call("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: "  My Project  " }),
    });
    expect(created.status).toBe(200);
    const key = (await created.json()) as { key: string; name: string; id: string };
    expect(key.name).toBe("My Project");
    expect(key.key.startsWith("sk-hc-v1-")).toBeTrue();

    const listed = (await (await call("/api/keys")).json()) as {
      keys: Array<{ id: string; keyPrefix: string }>;
    };
    expect(listed.keys.map((item) => item.id)).toEqual([key.id]);
    expect(key.key.startsWith(listed.keys[0]?.keyPrefix ?? "!")).toBeTrue();

    const webhooks = webhookRoutes({ sql });
    const revoked = await webhooks.handle(
      new Request(`${BASE_URL}/internal/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: key.key }),
      }),
    );
    expect(await revoked.json()).toEqual({ success: true, owner_email: null, key_name: "My Project" });
    expect((await revokeApiKeyByToken(sql, key.key)).alreadyRevoked).toBeTrue();
    expect((await revokeApiKeyByToken(sql, "sk-hc-v1-unknown")).found).toBeFalse();

    const afterRevoke = (await (await call("/api/keys")).json()) as { keys: unknown[] };
    expect(afterRevoke.keys).toEqual([]);

    // An owned key that is already revoked still answers success.
    const deletedRevoked = await call(`/api/keys/${key.id}`, { method: "DELETE" });
    expect(await deletedRevoked.json()).toEqual({ success: true });

    const second = (await (
      await call("/api/keys", { method: "POST", body: JSON.stringify({ name: "Second" }) })
    ).json()) as { id: string };
    const deleted = await call(`/api/keys/${second.id}`, { method: "DELETE" });
    expect(await deleted.json()).toEqual({ success: true });
    const notMine = await call(`/api/keys/${crypto.randomUUID()}`, { method: "DELETE" });
    expect(notMine.status).toBe(400);

    const other = await signIn("U-keys-other");
    const othersKey = (await (
      await call("/api/keys", { method: "POST", body: JSON.stringify({ name: "Theirs" }) }, other.cookie)
    ).json()) as { id: string };
    const stolen = await call(`/api/keys/${othersKey.id}`, { method: "DELETE" });
    expect(stolen.status).toBe(400);
  });
});

describe("keys API origin check", () => {
  const dismissedAt = async (userId: string) => {
    const [row] = await sql<{ agent_banner_dismissed_at: Date | null }[]>`
      SELECT agent_banner_dismissed_at FROM users WHERE id = ${userId}::uuid
    `;
    return row?.agent_banner_dismissed_at ?? null;
  };
  const dismissBanner = (cookie: string, headers: Record<string, string>) =>
    app.handle(
      new Request(`${BASE_URL}/api/dismiss-agent-banner`, {
        method: "POST",
        headers: { cookie, ...headers },
      }),
    );

  test("POST with a matching origin succeeds", async () => {
    const { userId, cookie } = await signIn("U-origin-ok");
    expect((await dismissBanner(cookie, { origin: BASE_URL })).status).toBe(204);
    expect(await dismissedAt(userId)).toBeInstanceOf(Date);
  });

  test.each([
    ["a foreign origin", { origin: "https://evil.example" }],
    ["sec-fetch-site cross-site", { "sec-fetch-site": "cross-site" }],
  ])("POST with %s is rejected even with a valid session", async (label, headers) => {
    const { userId, cookie } = await signIn(`U-origin-${label}`);
    expect((await dismissBanner(cookie, headers)).status).toBe(403);
    expect(await dismissedAt(userId)).toBeNull();
  });
});
