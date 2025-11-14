import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { users, sessions, apiKeys } from '../db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import type { AppVariables } from '../types';
import blockedAppsConfig from '../config/blocked-apps.json';

const BLOCKED_APPS = blockedAppsConfig.blockedApps.map(a => a.toLowerCase());

export async function blockAICodingAgents(c: Context, next: Next) {
  const referer = (c.req.header('Referer') || c.req.header('HTTP-Referer') || '').toLowerCase();
  const xTitle = (c.req.header('X-Title') || '').toLowerCase();

  const blockedApp = BLOCKED_APPS.find(app =>
    referer.includes(app) || xTitle.includes(app)
  );

  if (blockedApp) {
    const message = "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

    throw new HTTPException(403, {
      message,
      res: Response.json(
        { error: message },
        { status: 403 }
      )
    });
  }

  await next();
}

export async function requireAuth(c: Context<{ Variables: AppVariables }>, next: Next) {
  const sessionToken = getCookie(c, 'session_token');

  if (!sessionToken) {
    return c.redirect('/');
  }

  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.token, sessionToken),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) {
    return c.redirect('/');
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    return c.redirect('/');
  }

  c.set('user', user);
  await next();
}

export async function requireApiKey(c: Context<{ Variables: AppVariables }>, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  const key = authHeader.substring(7);

  const [apiKey] = await db
    .select({
      apiKey: apiKeys,
      user: users,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(
      and(
        eq(apiKeys.key, key),
        isNull(apiKeys.revokedAt)
      )
    )
    .limit(1);

  if (!apiKey) {
    throw new HTTPException(401, { message: 'Authentication failed' });
  }

  c.set('apiKey', apiKey.apiKey);
  c.set('user', apiKey.user);
  await next();
}
