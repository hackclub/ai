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

describe("verifyGitHubSignature", () => {
  test("rejects signatures that are not base64 instead of throwing", async () => {
    const { keys } = await signingKey();
    expect(await verifyGitHubSignature(keys, "[]", "not base64!", KEY_ID)).toBeFalse();
    expect(await verifyGitHubSignature(keys, "[]", "AAAA", "unknown-key")).toBeFalse();
  });

  test("accepts a signature made with the listed key", async () => {
    const { keys, sign } = await signingKey();
    expect(await verifyGitHubSignature(keys, "[]", await sign("[]"), KEY_ID)).toBeTrue();
    expect(await verifyGitHubSignature(keys, "[1]", await sign("[]"), KEY_ID)).toBeFalse();
  });
});

describe("POST /api/ghss", () => {
  const app = async () => {
    const { keys, sign } = await signingKey();
    const fetchImplementation = (async () => Response.json(keys)) as unknown as typeof fetch;
    // No revocations should be attempted by these tests.
    const sql = (async () => {
      throw new Error("unexpected query");
    }) as unknown as postgres.Sql;
    return { app: webhookRoutes({ sql, fetch: fetchImplementation }), sign };
  };

  const post = (body: string, headers: Record<string, string>) =>
    new Request("http://gateway.test/api/ghss", { method: "POST", body, headers });

  test("answers 403 for a malformed signature header", async () => {
    const { app: routes } = await app();
    const response = await routes.handle(
      post("[]", { "github-public-key-identifier": KEY_ID, "github-public-key-signature": "%%%" }),
    );
    expect(response.status).toBe(403);
  });

  test("answers 400 for a verified payload that is not a list of matches", async () => {
    const { app: routes, sign } = await app();
    for (const body of ['{"token":"x"}', "[1]", '[{"type":"x"}]', "nonsense"]) {
      const response = await routes.handle(
        post(body, {
          "github-public-key-identifier": KEY_ID,
          "github-public-key-signature": await sign(body),
        }),
      );
      expect(response.status).toBe(400);
    }
  });
});
