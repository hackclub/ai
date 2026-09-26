import type postgres from "postgres";

import type { Tables } from "../db-types";

type Sql = postgres.Sql;

const SESSION_COOKIE = "session_token";
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

type SessionRow = Pick<
  Tables["users"],
  | "id"
  | "slack_id"
  | "email"
  | "name"
  | "avatar"
  | "is_banned"
  | "is_idv_verified"
  | "skip_idv"
  | "agent_banner_dismissed_at"
> & { billing_account_id: string };

/** SHA-256 of the token. Byte-identical to `hashApiKey`, so stored sessions keep matching. */
const hashToken = (token: string): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("sha256").update(token).digest());

async function createSession(sql: Sql, userId: string) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}::uuid, ${hashToken(token)}, ${expiresAt})
  `;
  return { token, expiresAt };
}

async function deleteSession(sql: Sql, token: string) {
  await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
}

/**
 * Resolves a session cookie to its user, or null when absent or expired.
 * The INNER JOIN on `billing_accounts` is safe: every user has a billing
 * account. `createUser` is the only writer of `users` and creates both in
 * one transaction, and nothing deletes an account.
 */
async function sessionUser(
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
  let found: string | undefined;
  let count = 0;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    count += 1;
    // A value that is not valid percent-encoding is treated as no cookie,
    // not as a server error: the browser may hold one from a sibling host.
    try {
      found = decodeURIComponent(rest.join("="));
    } catch {
      return undefined;
    }
  }
  // Two cookies with the same name means one was planted by another host
  // on the parent domain. Treat as signed out rather than guess.
  return count === 1 ? found : undefined;
};

/**
 * `__Host-` locks a cookie to this exact host and to HTTPS: a sibling
 * subdomain cannot shadow it. The prefix is only valid on Secure cookies,
 * so plain-HTTP local dev keeps the bare name.
 */
export const cookieName = (base: string, secure: boolean) => (secure ? `__Host-${base}` : base);

export const serializeCookie = (
  name: string,
  value: string,
  options: { maxAge: number; path: string; secure: boolean },
) =>
  `${name}=${encodeURIComponent(value)}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`;

export type Sessions = {
  /** The signed-in user for a request's Cookie header, or null when absent, expired, duplicated or unknown. */
  user(cookieHeader: string | null): Promise<SessionUser | null>;
  /** Creates a session for the user; returns the Set-Cookie header value that carries it. */
  start(userId: string): Promise<string>;
  /** Deletes the request's session if there is one; returns the Set-Cookie value that clears the cookie. */
  end(cookieHeader: string | null): Promise<string>;
};

/**
 * The single owner of the session cookie. `secureCookies` is derived once in
 * `createBackend`; it selects the `__Host-` name and the `Secure` attribute.
 */
export const createSessions = (options: { sql: Sql; secureCookies: boolean }): Sessions => {
  const { sql, secureCookies: secure } = options;
  const name = cookieName(SESSION_COOKIE, secure);
  return {
    user: (cookieHeader) => sessionUser(sql, cookieValue(cookieHeader, name)),
    start: async (userId) => {
      const session = await createSession(sql, userId);
      return serializeCookie(name, session.token, { maxAge: SESSION_TTL_MS / 1_000, path: "/", secure });
    },
    end: async (cookieHeader) => {
      const token = cookieValue(cookieHeader, name);
      if (token) await deleteSession(sql, token);
      return serializeCookie(name, "", { maxAge: 0, path: "/", secure });
    },
  };
};

export type SessionAccess =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "signed-out" | "banned" };

/** Whether a resolved session user may use the dashboard and /api. Adapters map the reason to their own error. */
export const sessionAccess = (user: SessionUser | null): SessionAccess =>
  !user ? { ok: false, reason: "signed-out" } : user.isBanned ? { ok: false, reason: "banned" } : { ok: true, user };
