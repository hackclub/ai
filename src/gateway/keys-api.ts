import { Elysia } from "elysia";
import type postgres from "postgres";

import { createApiKey, listApiKeys, revokeOwnedApiKey } from "../auth/api-keys";
import { type Sessions, sessionAccess } from "../auth/sessions";
import { BANNED_MESSAGE } from "../auth/users";
import { HttpError } from "./http-error";
import { assertSameOrigin } from "./origin-check";

type Sql = postgres.Sql;

export type KeysApiOptions = {
  sql: Sql;
  /** Public origin of this deployment; mutations must come from it. */
  baseUrl: string;
  /** Resolves the session cookie; owns its name and attributes. */
  sessions: Sessions;
  onKeyCreated?: (userId: string, keyId: string, name: string) => void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session-authenticated JSON API used by the dashboard:
 * `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/:id`, and
 * `POST /api/dismiss-agent-banner`.
 */
export const keysApiRoutes = (options: KeysApiOptions) =>
  new Elysia({ prefix: "/api" })
    .derive(async ({ request }) => {
      assertSameOrigin(request, options.baseUrl);
      const access = sessionAccess(await options.sessions.user(request.headers.get("cookie")));
      if (!access.ok) {
        throw access.reason === "banned"
          ? new HttpError(403, BANNED_MESSAGE)
          : new HttpError(401, "Authentication required");
      }
      return { user: access.user };
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
      const created = await createApiKey(options.sql, user.id, body.name);
      options.onKeyCreated?.(user.id, created.id, created.name);
      return created;
    })
    .delete("/keys/:id", async ({ params, user }) => {
      const id = params.id;
      if (!UUID.test(id) || !(await revokeOwnedApiKey(options.sql, user.id, id))) {
        throw new HttpError(400, "Operation failed");
      }
      return { success: true };
    })
    .post("/dismiss-agent-banner", async ({ user }) => {
      await options.sql`
        UPDATE users SET agent_banner_dismissed_at = now() WHERE id = ${user.id}::uuid
      `;
      return new Response(null, { status: 204 });
    });
