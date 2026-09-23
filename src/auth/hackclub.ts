import { Elysia } from "elysia";
import type postgres from "postgres";

import { HttpError } from "../gateway/http-error";
import { assertSameOrigin } from "../gateway/origin-check";
import { type Sessions, cookieName, cookieValue, serializeCookie } from "./sessions";
import { createUser } from "./users";

type Sql = postgres.Sql;

export type HackClubIdentity = {
  id: string;
  slack_id: string | null;
  primary_email: string;
  first_name: string;
  last_name: string;
  verification_status: string;
  ysws_eligible: boolean;
};

export type HackClubAuthOptions = {
  sql: Sql;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  /** Selects the `__Host-` name and `Secure` attribute of the `oauth_state` cookie. */
  secureCookies: boolean;
  /** Starts and ends the dashboard session. */
  sessions: Sessions;
  fetch?: typeof fetch;
  onSignedIn?: (userId: string, identity: HackClubIdentity) => void;
};

const AUTH_BASE = "https://auth.hackclub.com";
const SCOPES = "email name slack_id verification_status";
const STATE_COOKIE = "oauth_state";

const avatarUrlForSlackId = (slackId: string) =>
  `https://cachet.hackclub.com/users/${encodeURIComponent(slackId)}/r`;

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/**
 * Upserts the signed-in identity. New users get a billing account and the
 * default daily allowance through createUser.
 */
async function upsertHackClubUser(sql: Sql, identity: HackClubIdentity) {
  if (!identity.slack_id) {
    throw new HttpError(400, "User does not have a linked Slack account");
  }
  const name = `${identity.first_name} ${identity.last_name}`.trim() || null;
  const avatar = avatarUrlForSlackId(identity.slack_id);
  const updateExisting = async () => {
    const [existing] = await sql<{ id: string }[]>`
      UPDATE users
      SET
        email = ${identity.primary_email},
        name = ${name},
        avatar = ${avatar},
        is_idv_verified = ${identity.ysws_eligible},
        updated_at = now()
      WHERE slack_id = ${identity.slack_id}
      RETURNING id
    `;
    return existing?.id ?? null;
  };

  const existingId = await updateExisting();
  if (existingId) return existingId;

  let created: Awaited<ReturnType<typeof createUser>>;
  try {
    created = await createUser(sql, {
      slackId: identity.slack_id,
      email: identity.primary_email,
      name,
      avatar,
    });
  } catch (error) {
    // Two first sign-ins for the same person landing together (two tabs, a
    // double click) both miss the update; the loser adopts the winner's row.
    if (isUniqueViolation(error)) {
      const racedId = await updateExisting();
      if (racedId) return racedId;
    }
    throw error;
  }
  await sql`
    UPDATE users SET is_idv_verified = ${identity.ysws_eligible}
    WHERE id = ${created.userId}::uuid
  `;
  return created.userId;
}

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "23505";

/** `/auth/login`, `/auth/callback`, and `/auth/logout`. */
export const hackClubAuthRoutes = (options: HackClubAuthOptions) => {
  const fetchImplementation = options.fetch ?? fetch;
  const redirectUri = `${options.baseUrl}/auth/callback`;
  const stateCookie = (value: string, maxAge: number) =>
    serializeCookie(cookieName(STATE_COOKIE, options.secureCookies), value, {
      maxAge,
      path: "/",
      secure: options.secureCookies,
    });

  return new Elysia({ prefix: "/auth" })
    .get("/login", () => {
      const state = crypto.randomUUID();
      const url = new URL(`${AUTH_BASE}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", SCOPES);
      url.searchParams.set("state", state);
      return redirect(url.toString(), [stateCookie(state, 600)]);
    })
    .get("/callback", async ({ request }) => {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const storedState = cookieValue(
        request.headers.get("cookie"),
        cookieName(STATE_COOKIE, options.secureCookies),
      );
      const clearState = stateCookie("", 0);

      if (!state || !storedState || state !== storedState) {
        throw new HttpError(400, "Invalid state parameter");
      }
      if (!code) return redirect("/", [clearState]);

      const tokenResponse = await fetchImplementation(`${AUTH_BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      if (!tokenResponse.ok) {
        throw new HttpError(400, "Failed to exchange code for token");
      }
      const token = (await tokenResponse.json()) as { access_token: string };

      const meResponse = await fetchImplementation(`${AUTH_BASE}/api/v1/me`, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      if (!meResponse.ok) throw new HttpError(401, "Failed to fetch user identity");
      const { identity } = (await meResponse.json()) as {
        identity: HackClubIdentity;
      };

      const userId = await upsertHackClubUser(options.sql, identity);
      const session = await options.sessions.start(userId);
      options.onSignedIn?.(userId, identity);

      return redirect("/dashboard", [clearState, session]);
    })
    .post("/logout", async ({ request }) => {
      assertSameOrigin(request, options.baseUrl);
      return redirect("/", [await options.sessions.end(request.headers.get("cookie"))]);
    });
};
