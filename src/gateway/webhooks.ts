import { Elysia } from "elysia";
import type postgres from "postgres";

import { revokeApiKeyByToken } from "./keys-api";

type Sql = postgres.Sql;

const GITHUB_KEYS_URL = "https://api.github.com/meta/public_keys/secret_scanning";
const REVOKER_URL = "https://revoke.hackclub.com/api/v1/revocations";

type GitHubPublicKeys = {
  public_keys: Array<{ key_identifier: string; key: string; is_current: boolean }>;
};

type SecretMatch = { token: string; type: string; url: string; source: string };

export type WebhookOptions = {
  sql: Sql;
  fetch?: typeof fetch;
};

const pemToBytes = (pem: string) =>
  Uint8Array.from(
    atob(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s/g, "")),
    (character) => character.charCodeAt(0),
  );

export const verifyGitHubSignature = async (
  keys: GitHubPublicKeys,
  payload: string,
  signature: string,
  keyId: string,
) => {
  const publicKey = keys.public_keys.find((key) => key.key_identifier === keyId);
  if (!publicKey) return false;
  const key = await crypto.subtle.importKey(
    "spki",
    pemToBytes(publicKey.key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)),
    new TextEncoder().encode(payload),
  );
};

/**
 * Inbound webhooks that revoke leaked keys: GitHub secret scanning at
 * `/api/ghss` and `/internal/revoke`. Neither carries a secret, as in the
 * previous gateway: revoking a key needs the key itself.
 */
export const webhookRoutes = (options: WebhookOptions) => {
  const fetchImplementation = options.fetch ?? fetch;
  let cachedKeys: { keys: GitHubPublicKeys; at: number } | null = null;

  const githubKeys = async () => {
    if (cachedKeys && Date.now() - cachedKeys.at < 60 * 60 * 1_000) {
      return cachedKeys.keys;
    }
    const response = await fetchImplementation(GITHUB_KEYS_URL, {
      headers: { accept: "application/json", "user-agent": "HackClub-AI-Secret-Scanning" },
    });
    if (!response.ok) throw new Error(`GitHub public keys: HTTP ${response.status}`);
    cachedKeys = { keys: (await response.json()) as GitHubPublicKeys, at: Date.now() };
    return cachedKeys.keys;
  };

  const notifyRevoker = (secret: SecretMatch) =>
    fetchImplementation(REVOKER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: secret.token,
        submitter: "github-secret-scanning",
        comment: [
          `GitHub Secret Scanning detected a leaked ${secret.type} in ${secret.source.replaceAll("_", " ")}`,
          secret.url,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    }).catch(() => {});

  return new Elysia()
    .post("/api/ghss", async ({ request }) => {
      const keyId = request.headers.get("github-public-key-identifier");
      const signature = request.headers.get("github-public-key-signature");
      if (!keyId || !signature) {
        return Response.json({ error: "Missing signature headers" }, { status: 400 });
      }
      const raw = await request.text();
      if (!(await verifyGitHubSignature(await githubKeys(), raw, signature, keyId))) {
        return Response.json({ error: "Invalid signature" }, { status: 403 });
      }
      const secrets = JSON.parse(raw) as SecretMatch[];
      const results = [];
      for (const secret of secrets) {
        const result = await revokeApiKeyByToken(options.sql, secret.token);
        if (result.found && !result.alreadyRevoked) await notifyRevoker(secret);
        results.push({
          token_raw: secret.token,
          token_type: secret.type,
          label: result.found ? "true_positive" : "false_positive",
        });
      }
      return results;
    })
    .post("/internal/revoke", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as { token?: unknown };
      if (typeof body.token !== "string") {
        return Response.json({ success: false }, { status: 400 });
      }
      const result = await revokeApiKeyByToken(options.sql, body.token);
      if (!result.found || result.alreadyRevoked) {
        return Response.json({ success: false }, { status: 400 });
      }
      return { success: true, owner_email: result.ownerEmail, key_name: result.keyName };
    });
};
