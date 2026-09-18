import type postgres from "postgres";

import { HttpError } from "../gateway/http-error";

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

const BANNED_MESSAGE = "You are banned from using this service.";
const SUSPENDED_MESSAGE = "This billing account is suspended.";
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
