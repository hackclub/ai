import * as Sentry from "@sentry/bun";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import blockedAppsConfig from "../config/blocked-apps.json";
import blockedPromptsConfig from "../config/blocked-prompts";
import blockedUserAgentsConfig from "../config/blocked-user-agents";
import { db } from "../db";
import { apiKeys, sessions, users } from "../db/schema";
import { env } from "../env";
import type { AppVariables } from "../types";

const BLOCKED_APPS = blockedAppsConfig.map((a) => a.toLowerCase());
const BLOCKED_USER_AGENTS = blockedUserAgentsConfig.map((a) => a.toLowerCase());
const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

export async function blockAICodingAgents(c: Context, next: Next) {
  const referer = c.req.header("Referer") || c.req.header("HTTP-Referer");
  const xTitle = c.req.header("X-Title");
  const userAgent = c.req.header("User-Agent");

  if (!referer && !xTitle && !userAgent) return next();

  const refererLower = (referer || "").toLowerCase();
  const xTitleLower = (xTitle || "").toLowerCase();
  const userAgentLower = (userAgent || "").toLowerCase();
  const ex = new HTTPException(403, {
    message: BLOCKED_MESSAGE,
    res: Response.json({ error: BLOCKED_MESSAGE }, { status: 403 }),
  });

  for (let i = 0; i < BLOCKED_APPS.length; i++) {
    const app = BLOCKED_APPS[i];
    if (refererLower.includes(app) || xTitleLower.includes(app)) {
      throw ex;
    }
  }

  for (let i = 0; i < BLOCKED_USER_AGENTS.length; i++) {
    const blockedAgent = BLOCKED_USER_AGENTS[i];
    if (userAgentLower.includes(blockedAgent)) {
      throw ex;
    }
  }

  if (c.req.method === "POST") {
    try {
      const clone = c.req.raw.clone();
      const body = await clone.text();

      for (const blockedPrompt of blockedPromptsConfig) {
        if (body.includes(blockedPrompt)) {
          throw ex;
        }
      }
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      // Ignore JSON parse errors or other issues, let the route handle validation
    }
  }

  await next();
}

export async function requireAuth(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  return Sentry.startSpan({ name: "middleware.requireAuth" }, async () => {
    const sessionToken = getCookie(c, "session_token");

    if (!sessionToken) {
      return c.redirect("/");
    }

    const [result] = await Sentry.startSpan(
      { name: "db.select.session" },
      async () => {
        return await db
          .select({
            user: users,
          })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(
            and(
              eq(sessions.token, sessionToken),
              gt(sessions.expiresAt, new Date()),
            ),
          )
          .limit(1);
      },
    );

    if (!result) {
      return c.redirect("/");
    }

    if (result.user.isBanned) {
      throw new HTTPException(403, {
        message: "You are banned from using this service.",
      });
    }

    c.set("user", result.user);
    if (env.SENTRY_DSN) {
      Sentry.setUser({
        email: result.user.email || undefined,
        slackId: result.user.slackId,
        name: result.user.name,
      });
    }
    await next();
  });
}

export async function requireApiKey(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  return Sentry.startSpan({ name: "middleware.requireApiKey" }, async () => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    const key = authHeader.substring(7);

    const [apiKey] = await Sentry.startSpan(
      { name: "db.select.apiKey" },
      async () => {
        return await db
          .select({
            apiKey: apiKeys,
            user: users,
          })
          .from(apiKeys)
          .innerJoin(users, eq(apiKeys.userId, users.id))
          .where(and(eq(apiKeys.key, key), isNull(apiKeys.revokedAt)))
          .limit(1);
      },
    );

    if (!apiKey) {
      throw new HTTPException(401, { message: "Authentication failed" });
    }

    c.set("apiKey", apiKey.apiKey);
    c.set("user", apiKey.user);

    if (apiKey.user.isBanned) {
      throw new HTTPException(403, {
        message: "You are banned from using this service.",
      });
    }

    if (env.ENFORCE_IDV && !apiKey.user.skipIdv && !apiKey.user.isIdvVerified) {
      throw new HTTPException(403, {
        message:
          "Identity verification required. Please verify at https://identity.hackclub.com",
      });
    }

    await next();
  });
}
