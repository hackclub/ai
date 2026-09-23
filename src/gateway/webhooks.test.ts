import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import { verifyGitHubSignature, webhookRoutes } from "./webhooks";

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

/**
 * Webhook routes over a fake `sql` whose SELECT returns `selectRows`, and a
 * fetch that serves the GitHub key listing and records revoker notifications.
 */
const setup = async (selectRows: unknown[] = []) => {
  const { keys, sign } = await signingKey();
  const queries: string[] = [];
  const revokerCalls: unknown[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    return /^\s*UPDATE/i.test(text) ? [] : selectRows;
  }) as unknown as postgres.Sql;
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
  const updates = () => queries.filter((q) => /^\s*UPDATE api_keys SET revoked_at/i.test(q)).length;
  return { ghss, revoke, queries, revokerCalls, updates };
};

const keyRow = (revoked: boolean) => ({ id: "k1", name: "My key", revoked, owner_email: null });

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
  const match = JSON.stringify([
    { token: "sk-hc-v1-x", type: "hack_club_ai_key", url: "https://github.com/x", source: "commit" },
  ]);

  test("answers 403 for a malformed signature header without touching keys", async () => {
    const { ghss, queries } = await setup();
    expect((await ghss("[]", "%%%")).status).toBe(403);
    expect(queries).toEqual([]);
  });

  test("answers 400 for a verified payload that is not a list of matches", async () => {
    const { ghss, queries } = await setup();
    for (const body of ['{"token":"x"}', "[1]", '[{"type":"x"}]', "nonsense"]) {
      expect((await ghss(body)).status).toBe(400);
    }
    expect(queries).toEqual([]);
  });

  test.each([
    ["revokes and notifies an unrevoked match", [keyRow(false)], "true_positive", 1],
    ["does not re-revoke or re-notify an already-revoked match", [keyRow(true)], "true_positive", 0],
    ["labels an unknown token false_positive without revoking", [], "false_positive", 0],
  ] as const)("%s", async (_, rows, label, revocations) => {
    const { ghss, updates, revokerCalls } = await setup([...rows]);
    const response = await ghss(match);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { token_raw: "sk-hc-v1-x", token_type: "hack_club_ai_key", label },
    ]);
    expect(updates()).toBe(revocations);
    expect(revokerCalls).toHaveLength(revocations);
  });
});

test("POST /internal/revoke revokes a known token and 400s an unknown one", async () => {
  const found = await (await setup([keyRow(false)])).revoke({ token: "sk-hc-v1-x" });
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual({ success: true, owner_email: null, key_name: "My key" });

  const notFound = await (await setup()).revoke({ token: "sk-hc-v1-x" });
  expect(notFound.status).toBe(400);
  expect(await notFound.json()).toEqual({ success: false });
});
