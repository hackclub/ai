import type postgres from "postgres";

import { hashApiKey } from "./api-keys";

type Sql = postgres.Sql;

export const SESSION_COOKIE = "session_token";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type SessionUser = {
  id: string;
  slackId: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  isBanned: boolean;
  isIdvVerified: boolean;
  skipIdv: boolean;
  agentBannerDismissedAt: Date | null;
  billingAccountId: string;
};

type SessionRow = {
  id: string;
  slack_id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  is_banned: boolean;
  is_idv_verified: boolean;
  skip_idv: boolean;
  agent_banner_dismissed_at: Date | null;
  billing_account_id: string;
};

const hashToken = hashApiKey;

export async function createSession(sql: Sql, userId: string) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}::uuid, ${hashToken(token)}, ${expiresAt})
  `;
  return { token, expiresAt };
}

export async function deleteSession(sql: Sql, token: string) {
  await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
}

/** Resolves a session cookie to its user, or null when absent or expired. */
export async function sessionUser(
  sql: Sql,
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await sql<SessionRow[]>`
    SELECT
      app_user.id,
      app_user.slack_id,
      app_user.email,
      app_user.name,
      app_user.avatar,
      app_user.is_banned,
      app_user.is_idv_verified,
      app_user.skip_idv,
      app_user.agent_banner_dismissed_at,
      account.id AS billing_account_id
    FROM sessions
    JOIN users AS app_user ON app_user.id = sessions.user_id
    JOIN billing_accounts AS account
      ON account.owner_type = 'user' AND account.owner_id = app_user.id
    WHERE sessions.token_hash = ${hashToken(token)} AND sessions.expires_at > now()
    LIMIT 1
  `;
  if (!row) return null;
  return {
    id: row.id,
    slackId: row.slack_id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    isBanned: row.is_banned,
    isIdvVerified: row.is_idv_verified,
    skipIdv: row.skip_idv,
    agentBannerDismissedAt: row.agent_banner_dismissed_at,
    billingAccountId: row.billing_account_id,
  };
}

export const cookieValue = (cookieHeader: string | null, name: string) => {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      // A value that is not valid percent-encoding is treated as no cookie,
      // not as a server error: the browser may hold one from a sibling host.
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

export const serializeCookie = (
  name: string,
  value: string,
  options: { maxAge: number; path: string; secure: boolean },
) =>
  `${name}=${encodeURIComponent(value)}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`;
