import { describe, expect, test } from "bun:test";

import { issueApiKey } from "../auth/api-keys";
import { createUser } from "../auth/users";
import { testDatabase } from "../test/database";
import { verifyGitHubSignature, webhookRoutes } from "./webhooks";

const { sql } = await testDatabase();

const KEY_ID = "test-key";

/** A P-256 key pair plus the PEM GitHub's key listing would carry. */
const signingKey = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
  const sign = async (payload: string) => {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(payload),
    );
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  };
  return { keys: { public_keys: [{ key_identifier: KEY_ID, key: pem, is_current: true }] }, sign };
};

let created = 0;
/** A real user and API key named "My key"; `revoked` marks it revoked first. */
const createKey = async (revoked = false) => {
  const user = await createUser(sql, { slackId: `U-webhook-${++created}` });
  const issued = await issueApiKey(sql, user.userId, "My key");
  if (revoked) await sql`UPDATE api_keys SET revoked_at = now() - INTERVAL '1 day' WHERE id = ${issued.id}`;
  return issued;
};
const revokedAt = async (id: string) =>
  (await sql<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM api_keys WHERE id = ${id}`)[0]?.revoked_at ?? null;

/**
 * Webhook routes over the real database, with a fetch that serves the
 * GitHub key listing and records revoker notifications (both external).
 */
const setup = async () => {
  const { keys, sign } = await signingKey();
  const revokerCalls: unknown[] = [];
  const fetchImplementation = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("revoke.hackclub.com")) {
      revokerCalls.push(init);
      return Response.json({ ok: true });
    }
    return Response.json(keys);
  }) as unknown as typeof fetch;
  const routes = webhookRoutes({ sql, fetch: fetchImplementation });
  const ghss = async (body: string, signature?: string) =>
    routes.handle(
      new Request("http://gateway.test/api/ghss", {
        method: "POST",
        body,
        headers: {
          "github-public-key-identifier": KEY_ID,
          "github-public-key-signature": signature ?? (await sign(body)),
        },
      }),
    );
  const revoke = (body: unknown) =>
    routes.handle(
      new Request("http://gateway.test/internal/revoke", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  return { ghss, revoke, revokerCalls };
};

describe("verifyGitHubSignature", () => {
  test("rejects malformed signatures and unknown key ids instead of throwing", async () => {
    const { keys } = await signingKey();
    expect(await verifyGitHubSignature(keys, "[]", "not base64!", KEY_ID)).toBeFalse();
    expect(await verifyGitHubSignature(keys, "[]", "AAAA", "unknown-key")).toBeFalse();
  });

  test("accepts only a signature over the exact payload", async () => {
    const { keys, sign } = await signingKey();
    expect(await verifyGitHubSignature(keys, "[]", await sign("[]"), KEY_ID)).toBeTrue();
    expect(await verifyGitHubSignature(keys, "[1]", await sign("[]"), KEY_ID)).toBeFalse();
  });
});

describe("POST /api/ghss", () => {
  const matchFor = (token: string) =>
    JSON.stringify([{ token, type: "hack_club_ai_key", url: "https://github.com/x", source: "commit" }]);

  test("answers 403 for a malformed signature header without touching keys", async () => {
    const key = await createKey();
    const { ghss } = await setup();
    expect((await ghss(matchFor(key.key), "%%%")).status).toBe(403);
    expect(await revokedAt(key.id)).toBeNull();
  });

  test("answers 400 for a verified payload that is not a list of matches", async () => {
    const key = await createKey();
    const { ghss } = await setup();
    for (const body of [JSON.stringify({ token: key.key }), "[1]", '[{"type":"x"}]', "nonsense"]) {
      expect((await ghss(body)).status).toBe(400);
    }
    expect(await revokedAt(key.id)).toBeNull();
  });

  test("revokes and notifies an unrevoked match", async () => {
    const key = await createKey();
    const { ghss, revokerCalls } = await setup();
    const response = await ghss(matchFor(key.key));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ token_raw: key.key, token_type: "hack_club_ai_key", label: "true_positive" }]);
    expect(await revokedAt(key.id)).not.toBeNull();
    expect(revokerCalls).toHaveLength(1);
  });

  test("does not re-revoke or re-notify an already-revoked match", async () => {
    const key = await createKey(true);
    const before = await revokedAt(key.id);
    const { ghss, revokerCalls } = await setup();
    const response = await ghss(matchFor(key.key));
    expect(await response.json()).toEqual([{ token_raw: key.key, token_type: "hack_club_ai_key", label: "true_positive" }]);
    expect(await revokedAt(key.id)).toEqual(before);
    expect(revokerCalls).toHaveLength(0);
  });

  test("labels an unknown token false_positive without revoking", async () => {
    const key = await createKey();
    const { ghss, revokerCalls } = await setup();
    const response = await ghss(matchFor("sk-hc-v1-unknown"));
    expect(await response.json()).toEqual([
      { token_raw: "sk-hc-v1-unknown", token_type: "hack_club_ai_key", label: "false_positive" },
    ]);
    expect(await revokedAt(key.id)).toBeNull();
    expect(revokerCalls).toHaveLength(0);
  });
});

test("POST /internal/revoke revokes a known token and 400s an unknown one", async () => {
  const key = await createKey();
  const { revoke } = await setup();
  const found = await revoke({ token: key.key });
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual({ success: true, owner_email: null, key_name: "My key" });
  expect(await revokedAt(key.id)).not.toBeNull();

  const notFound = await revoke({ token: "sk-hc-v1-unknown" });
  expect(notFound.status).toBe(400);
  expect(await notFound.json()).toEqual({ success: false });
});
