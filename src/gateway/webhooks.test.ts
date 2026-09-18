import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import { verifyGitHubSignature, webhookRoutes } from "./webhooks";

type WebhookApp = ReturnType<typeof webhookRoutes>;

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

describe("POST /api/ghss revokes matches", () => {
  const recordingSql = (selectRows: unknown[]) => {
    const queries: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      queries.push(text);
      return /^\s*UPDATE/i.test(text) ? [] : selectRows;
    }) as unknown as postgres.Sql;
    return { sql, queries };
  };

  const recordingFetch = (keys: unknown) => {
    const revokerCalls: unknown[] = [];
    const fetchImplementation = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("revoke.hackclub.com")) {
        revokerCalls.push(init);
        return Response.json({ ok: true });
      }
      return Response.json(keys);
    }) as unknown as typeof fetch;
    return { fetchImplementation, revokerCalls };
  };

  const body = JSON.stringify([
    { token: "sk-hc-v1-x", type: "hack_club_ai_key", url: "https://github.com/x", source: "commit" },
  ]);

  const post = (payload: string, headers: Record<string, string>) =>
    new Request("http://gateway.test/api/ghss", { method: "POST", body: payload, headers });

  const send = async (
    payload: string,
    sign: (payload: string) => Promise<string>,
    routes: WebhookApp,
  ) =>
    routes.handle(
      post(payload, {
        "github-public-key-identifier": KEY_ID,
        "github-public-key-signature": await sign(payload),
      }),
    );

  test("revokes an unrevoked match, notifies the revoker, and labels it true_positive", async () => {
    const { keys, sign } = await signingKey();
    const { fetchImplementation, revokerCalls } = recordingFetch(keys);
    const { sql, queries } = recordingSql([
      { id: "k1", name: "My key", revoked: false, owner_email: null },
    ]);
    const routes = webhookRoutes({ sql, fetch: fetchImplementation });

    const response = await send(body, sign, routes);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { token_raw: "sk-hc-v1-x", token_type: "hack_club_ai_key", label: "true_positive" },
    ]);
    expect(queries.filter((q) => /^\s*UPDATE api_keys SET revoked_at/i.test(q))).toHaveLength(1);
    expect(queries.filter((q) => /^\s*SELECT/i.test(q))).toHaveLength(1);
    expect(revokerCalls).toHaveLength(1);
  });

  test("does not re-revoke or re-notify an already-revoked match", async () => {
    const { keys, sign } = await signingKey();
    const { fetchImplementation, revokerCalls } = recordingFetch(keys);
    const { sql, queries } = recordingSql([
      { id: "k1", name: "My key", revoked: true, owner_email: null },
    ]);
    const routes = webhookRoutes({ sql, fetch: fetchImplementation });

    const response = await send(body, sign, routes);
    expect(await response.json()).toEqual([
      { token_raw: "sk-hc-v1-x", token_type: "hack_club_ai_key", label: "true_positive" },
    ]);
    expect(queries.filter((q) => /^\s*UPDATE/i.test(q))).toHaveLength(0);
    expect(revokerCalls).toHaveLength(0);
  });

  test("labels an unknown token false_positive without revoking or notifying", async () => {
    const { keys, sign } = await signingKey();
    const { fetchImplementation, revokerCalls } = recordingFetch(keys);
    const { sql, queries } = recordingSql([]);
    const routes = webhookRoutes({ sql, fetch: fetchImplementation });

    const response = await send(body, sign, routes);
    expect(await response.json()).toEqual([
      { token_raw: "sk-hc-v1-x", token_type: "hack_club_ai_key", label: "false_positive" },
    ]);
    expect(queries.filter((q) => /^\s*UPDATE/i.test(q))).toHaveLength(0);
    expect(revokerCalls).toHaveLength(0);
  });

  test("labels each match in a multi-match payload independently, in order", async () => {
    const { keys, sign } = await signingKey();
    const { fetchImplementation } = recordingFetch(keys);
    const { sql } = recordingSql([{ id: "k1", name: "My key", revoked: false, owner_email: null }]);
    const routes = webhookRoutes({ sql, fetch: fetchImplementation });

    const twoMatches = JSON.stringify([
      { token: "sk-hc-v1-known", type: "hack_club_ai_key", url: "https://github.com/a", source: "commit" },
      { token: "sk-hc-v1-unknown", type: "hack_club_ai_key", url: "https://github.com/b", source: "commit" },
    ]);
    const response = await send(twoMatches, sign, routes);
    expect(await response.json()).toEqual([
      { token_raw: "sk-hc-v1-known", token_type: "hack_club_ai_key", label: "true_positive" },
      { token_raw: "sk-hc-v1-unknown", token_type: "hack_club_ai_key", label: "true_positive" },
    ]);
  });
});

describe("POST /internal/revoke", () => {
  const recordingSql = (selectRows: unknown[]) =>
    (async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      return /^\s*UPDATE/i.test(text) ? [] : selectRows;
    }) as unknown as postgres.Sql;

  const post = (body: unknown) =>
    new Request("http://gateway.test/internal/revoke", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  test("revokes an unrevoked token, 400s when the token is unknown", async () => {
    const found = recordingSql([{ id: "k1", name: "My key", revoked: false, owner_email: null }]);
    const foundResponse = await webhookRoutes({ sql: found }).handle(post({ token: "sk-hc-v1-x" }));
    expect(foundResponse.status).toBe(200);
    expect(await foundResponse.json()).toEqual({
      success: true,
      owner_email: null,
      key_name: "My key",
    });

    const notFound = recordingSql([]);
    const notFoundResponse = await webhookRoutes({ sql: notFound }).handle(
      post({ token: "sk-hc-v1-x" }),
    );
    expect(notFoundResponse.status).toBe(400);
    expect(await notFoundResponse.json()).toEqual({ success: false });
  });
});
