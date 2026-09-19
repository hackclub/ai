import { afterAll, beforeAll, describe, expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { createSession, SESSION_COOKIE } from "../auth/sessions";
import { createUser } from "../auth/users";
import { integrationDatabaseUrl, integrationTestFor } from "../test/integration-db";
import { keysApiRoutes, revokeApiKeyByToken } from "./keys-api";
import { webhookRoutes } from "./webhooks";

const databaseUrl = integrationDatabaseUrl("BILLING_TEST_DATABASE_URL");
const integrationTest = integrationTestFor(databaseUrl);
const runId = crypto.randomUUID().slice(0, 8);

describe("keys API and revoke webhooks with PostgreSQL", () => {
  let sql: Sql | undefined;
  let userId: string;
  let accountId: string;
  let cookie: string;

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 2 });
    const user = await createUser(sql, { slackId: `U-keys-${runId}` });
    userId = user.userId;
    accountId = user.billingAccountId;
    cookie = `${SESSION_COOKIE}=${(await createSession(sql, userId)).token}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM billing_funding_policies WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_accounts WHERE id = ${accountId}::uuid`;
    await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
    await sql.end();
  });

  integrationTest("requires a session", async () => {
    if (!sql) throw new Error("Missing database");
    const response = await keysApiRoutes({ sql, baseUrl: "http://gateway.test", secureCookies: false }).handle(
      new Request("http://gateway.test/api/keys"),
    );
    expect(response.status).toBe(401);
  });

  integrationTest("creates, lists, revokes, and validates names", async () => {
    if (!sql) throw new Error("Missing database");
    const app = keysApiRoutes({ sql, baseUrl: "http://gateway.test", secureCookies: false });
    const call = (path: string, init: RequestInit = {}) =>
      app.handle(
        new Request(`http://gateway.test${path}`, {
          ...init,
          headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
        }),
      );

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
      new Request("http://gateway.test/internal/revoke", {
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

    const second = (await (
      await call("/api/keys", { method: "POST", body: JSON.stringify({ name: "Second" }) })
    ).json()) as { id: string };
    const deleted = await call(`/api/keys/${second.id}`, { method: "DELETE" });
    expect(await deleted.json()).toEqual({ success: true });
    const notMine = await call(`/api/keys/${crypto.randomUUID()}`, { method: "DELETE" });
    expect(notMine.status).toBe(400);
  });
});
