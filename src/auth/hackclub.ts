import { Elysia } from "elysia";
import type postgres from "postgres";

import { HttpError } from "../gateway/http-error";
import { assertSameOrigin } from "../gateway/origin-check";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieValue,
  createSession,
  deleteSession,
  serializeCookie,
} from "./sessions";
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
  addresses?: Array<{ country: string; primary: boolean }>;
};

export type HackClubAuthOptions = {
  sql: Sql;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  secureCookies: boolean;
  fetch?: typeof fetch;
  /** Called with the identity when a flagged-country address is present. */
  onFlaggedCountry?: (identity: HackClubIdentity) => Promise<void>;
  onSignedIn?: (userId: string, identity: HackClubIdentity) => void;
};

const AUTH_BASE = "https://auth.hackclub.com";
const SCOPES = "email name slack_id verification_status address";
const STATE_COOKIE = "oauth_state";

const avatarUrlForSlackId = (slackId: string) =>
  `https://cachet.hackclub.com/users/${encodeURIComponent(slackId)}/r`;

// Fraud is concentrated from these places; sign-in is reported, not blocked.
const FLAGGED_COUNTRIES = new Set(["CN", "CHINA", "HK", "HONG KONG", "IN", "INDIA"]);

const hasFlaggedCountry = (identity: HackClubIdentity) =>
  identity.addresses?.some((address) =>
    FLAGGED_COUNTRIES.has(address.country.trim().toUpperCase()),
  ) ?? false;

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
    serializeCookie(STATE_COOKIE, value, {
      maxAge,
      path: "/auth",
      secure: options.secureCookies,
    });
  const sessionCookie = (value: string, maxAge: number) =>
    serializeCookie(SESSION_COOKIE, value, {
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
      const storedState = cookieValue(request.headers.get("cookie"), STATE_COOKIE);
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

      if (hasFlaggedCountry(identity)) {
        try {
          await options.onFlaggedCountry?.(identity);
        } catch {
          throw new HttpError(
            400,
            "Please contact support and send this error code: willow-savannah-tunnel-windermere",
          );
        }
      }

      const userId = await upsertHackClubUser(options.sql, identity);
      const session = await createSession(options.sql, userId);
      options.onSignedIn?.(userId, identity);

      return redirect("/dashboard", [
        clearState,
        sessionCookie(session.token, SESSION_TTL_MS / 1_000),
      ]);
    })
    .post("/logout", async ({ request }) => {
      assertSameOrigin(request, options.baseUrl);
      const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
      if (token) await deleteSession(options.sql, token);
      return redirect("/", [sessionCookie("", 0)]);
    });
};
