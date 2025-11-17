import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { users, sessions, apiKeys } from '../db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import type { AppVariables } from '../types';
import blockedAppsConfig from '../config/blocked-apps.json';
import { getEnforceIdv } from '../env';

const BLOCKED_APPS = blockedAppsConfig.blockedApps.map((a) => a.toLowerCase());
const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

export async function blockAICodingAgents(c: Context, next: Next) {
  const referer = c.req.header("Referer") || c.req.header("HTTP-Referer");
  const xTitle = c.req.header("X-Title");

  if (!referer && !xTitle) return next();

  const refererLower = (referer || "").toLowerCase();
  const xTitleLower = (xTitle || "").toLowerCase();

  for (let i = 0; i < BLOCKED_APPS.length; i++) {
    const app = BLOCKED_APPS[i];
    if (refererLower.includes(app) || xTitleLower.includes(app)) {
      throw new HTTPException(403, {
        message: BLOCKED_MESSAGE,
        res: Response.json({ error: BLOCKED_MESSAGE }, { status: 403 }),
      });
    }
  }

  await next();
}

export async function requireAuth(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  const sessionToken = getCookie(c, "session_token");

  if (!sessionToken) {
    return c.redirect("/");
  }

  const [result] = await db
    .select({
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(eq(sessions.token, sessionToken), gt(sessions.expiresAt, new Date())),
    )
    .limit(1);

  if (!result) {
    return c.redirect("/");
  }

  c.set("user", result.user);
  await next();
}

export async function requireApiKey(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const key = authHeader.substring(7);

  const [apiKey] = await db
    .select({
      apiKey: apiKeys,
      user: users,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.key, key), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!apiKey) {
    throw new HTTPException(401, { message: "Authentication failed" });
  }

  if (getEnforceIdv() && !apiKey.user.isIdvVerified) {
    throw new HTTPException(403, {
      message: 'Identity verification required. Please visit https://identity.hackclub.com to verify your identity.',
      res: Response.json(
        { error: 'Identity verification required. Please visit https://identity.hackclub.com to verify your identity.' },
        { status: 403 }
      )
    });
  }

  c.set('apiKey', apiKey.apiKey);
  c.set('user', apiKey.user);
  await next();
}
