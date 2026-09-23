import type postgres from "postgres";

import { HttpError } from "../gateway/http-error";
import { BANNED_MESSAGE } from "./users";

type Sql = postgres.Sql;

const API_KEY_PREFIX = "sk-hc-v1-";

export type AuthenticatedPrincipal = {
  userId: string;
  apiKeyId: string;
  billingAccountId: string;
};

export type ApiKeyAuthOptions = {
  enforceIdv: boolean;
};

type PrincipalRow = {
  user_id: string;
  api_key_id: string;
  billing_account_id: string | null;
  billing_account_status: string | null;
  is_banned: boolean;
  is_idv_verified: boolean;
  skip_idv: boolean;
};

const SUSPENDED_MESSAGE = "This billing account is suspended.";
const MAX_ACTIVE_KEYS = 50;
const IDV_MESSAGE =
  "Identity verification required. Please verify at https://identity.hackclub.com";

export const hashApiKey = (key: string): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("sha256").update(key).digest());

export const generateApiKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = `${API_KEY_PREFIX}${Buffer.from(bytes).toString("hex")}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 16) };
};

export const bearerToken = (authorization: string | undefined) => {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
};

/**
 * Resolves the bearer key to its user and billing account. Failures are
 * reported with the previous gateway's status codes and messages.
 */
export async function authenticateApiKey(
  sql: Sql,
  authorization: string | undefined,
  options: ApiKeyAuthOptions,
): Promise<AuthenticatedPrincipal> {
  const token = bearerToken(authorization);
  if (!token) throw new HttpError(401, "Authentication required");

  const [row] = await sql<PrincipalRow[]>`
    SELECT
      api_key.id AS api_key_id,
      app_user.id AS user_id,
      account.id AS billing_account_id,
      account.status AS billing_account_status,
      app_user.is_banned,
      app_user.is_idv_verified,
      app_user.skip_idv
    FROM api_keys AS api_key
    JOIN users AS app_user ON app_user.id = api_key.user_id
    LEFT JOIN billing_accounts AS account
      ON account.owner_type = 'user' AND account.owner_id = app_user.id
    WHERE
      api_key.key_hash = ${hashApiKey(token)}
      AND api_key.revoked_at IS NULL
    LIMIT 1
  `;
  if (!row) throw new HttpError(401, "Authentication failed");
  if (row.is_banned) throw new HttpError(403, BANNED_MESSAGE);
  if (options.enforceIdv && !row.skip_idv && !row.is_idv_verified) {
    throw new HttpError(403, IDV_MESSAGE);
  }
  if (!row.billing_account_id) {
    throw new HttpError(403, "No billing account is attached to this user");
  }
  if (row.billing_account_status && row.billing_account_status !== "active") {
    throw new HttpError(403, SUSPENDED_MESSAGE);
  }

  return {
    userId: row.user_id,
    apiKeyId: row.api_key_id,
    billingAccountId: row.billing_account_id,
  };
}

/** Best-effort usage stamp; never blocks or fails a request. */
export const touchApiKey = (sql: Sql, apiKeyId: string) => {
  sql`
    UPDATE api_keys
    SET last_used_at = now()
    WHERE
      id = ${apiKeyId}::uuid
      AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '1 minute')
  `.catch(() => {});
};

export type IssuedApiKey = {
  id: string;
  /** The plaintext key. It is shown once and never stored. */
  key: string;
  keyPrefix: string;
};

export async function issueApiKey(
  sql: Sql,
  userId: string,
  name: string,
): Promise<IssuedApiKey> {
  const generated = generateApiKey();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
    VALUES (
      ${userId}::uuid,
      ${generated.keyHash},
      ${generated.keyPrefix},
      ${name}
    )
    RETURNING id
  `;
  if (!row) throw new Error("PostgreSQL did not return the new API key");
  return { id: row.id, key: generated.key, keyPrefix: generated.keyPrefix };
}

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export async function listApiKeys(sql: Sql, userId: string): Promise<ApiKeySummary[]> {
  const rows = await sql<
    { id: string; name: string; key_prefix: string; created_at: Date; last_used_at: Date | null }[]
  >`
    SELECT id, name, key_prefix, created_at, last_used_at
    FROM api_keys
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Validates the name and the active-key cap, then issues a key. */
export async function createApiKey(sql: Sql, userId: string, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length < 1 || name.length > 100) {
    throw new HttpError(400, "Key name must be between 1 and 100 characters");
  }
  const [count] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM api_keys
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
  `;
  if ((count?.count ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new HttpError(400, "Maximum API key limit reached");
  }
  const issued = await issueApiKey(sql, userId, name);
  return { key: issued.key, name, id: issued.id };
}

/**
 * Revokes one of the user's keys. False when the key does not exist or is
 * someone else's; an owned key that is already revoked still returns true.
 */
export async function revokeOwnedApiKey(sql: Sql, userId: string, apiKeyId: string): Promise<boolean> {
  const [owned] = await sql<{ id: string }[]>`
    SELECT id FROM api_keys WHERE id = ${apiKeyId}::uuid AND user_id = ${userId}::uuid
  `;
  if (!owned) return false;
  await sql`
    UPDATE api_keys
    SET revoked_at = now()
    WHERE id = ${apiKeyId}::uuid AND user_id = ${userId}::uuid AND revoked_at IS NULL
  `;
  return true;
}

/** Revokes by plaintext token. Used by the internal and GitHub webhooks. */
export async function revokeApiKeyByToken(sql: Sql, token: string) {
  const [row] = await sql<
    { id: string; name: string; revoked: boolean; owner_email: string | null }[]
  >`
    SELECT api_key.id, api_key.name, api_key.revoked_at IS NOT NULL AS revoked,
      app_user.email AS owner_email
    FROM api_keys AS api_key
    JOIN users AS app_user ON app_user.id = api_key.user_id
    WHERE api_key.key_hash = ${hashApiKey(token)}
    LIMIT 1
  `;
  if (!row) return { found: false as const };
  if (!row.revoked) {
    await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${row.id}::uuid`;
  }
  return {
    found: true as const,
    alreadyRevoked: row.revoked,
    keyName: row.name,
    ownerEmail: row.owner_email,
  };
}
