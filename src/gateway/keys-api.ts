import { Elysia } from "elysia";
import type postgres from "postgres";

import { hashApiKey } from "../auth/api-keys";
import { SESSION_COOKIE, cookieValue, sessionUser } from "../auth/sessions";
import { issueApiKey, revokeApiKey } from "../auth/users";
import { HttpError } from "./http-error";

type Sql = postgres.Sql;

export type KeysApiOptions = {
  sql: Sql;
  onKeyCreated?: (userId: string, keyId: string, name: string) => void;
};

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

const MAX_ACTIVE_KEYS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function createApiKeyForUser(sql: Sql, userId: string, rawName: unknown) {
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

/**
 * Session-authenticated JSON API used by the dashboard:
 * `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/:id`, and
 * `POST /api/dismiss-agent-banner`.
 */
export const keysApiRoutes = (options: KeysApiOptions) =>
  new Elysia({ prefix: "/api" })
    .derive(async ({ request }) => {
      const user = await sessionUser(
        options.sql,
        cookieValue(request.headers.get("cookie"), SESSION_COOKIE),
      );
      if (!user) throw new HttpError(401, "Authentication required");
      if (user.isBanned) throw new HttpError(403, "You are banned from using this service.");
      return { user };
    })
    .get("/keys", async ({ user }) => ({
      keys: await listApiKeys(options.sql, user.id),
    }))
    .post("/keys", async ({ request, user }) => {
      let body: { name?: unknown } = {};
      try {
        body = (await request.json()) as { name?: unknown };
      } catch {
        throw new HttpError(400, "Request body must be valid JSON");
      }
      const created = await createApiKeyForUser(options.sql, user.id, body.name);
      options.onKeyCreated?.(user.id, created.id, created.name);
      return created;
    })
    .delete("/keys/:id", async ({ params, user }) => {
      const id = params.id;
      if (!UUID.test(id)) throw new HttpError(400, "Operation failed");
      const [owned] = await options.sql<{ id: string }[]>`
        SELECT id FROM api_keys WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
      `;
      if (!owned) throw new HttpError(400, "Operation failed");
      await revokeApiKey(options.sql, user.id, id);
      return { success: true };
    })
    .post("/dismiss-agent-banner", async ({ user }) => {
      await options.sql`
        UPDATE users SET agent_banner_dismissed_at = now() WHERE id = ${user.id}::uuid
      `;
      return new Response(null, { status: 204 });
    });
