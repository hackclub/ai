import * as Sentry from "@sentry/bun";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { db } from "../db";
import { apiKeys, requestLogs, sessions } from "../db/schema";
import { allowedEmbeddingModels, allowedLanguageModels, env } from "../env";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Dashboard } from "../views/dashboard";
import { Home } from "../views/home";

const dashboard = new Hono<{ Variables: AppVariables }>();

dashboard.get("/", async (c) => {
  const sessionToken = getCookie(c, "session_token");

  if (sessionToken) {
    const [session] = await Sentry.startSpan(
      { name: "db.select.session" },
      async () => {
        return await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.token, sessionToken),
              gt(sessions.expiresAt, new Date()),
            ),
          )
          .limit(1);
      },
    );

    if (session) {
      return c.redirect("/dashboard");
    }
  }

  return c.html(<Home models={allowedLanguageModels} />);
});

dashboard.get("/dashboard", requireAuth, async (c) => {
  const user = c.get("user");

  const keys = await Sentry.startSpan(
    { name: "db.select.apiKeys" },
    async () => {
      return await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          createdAt: apiKeys.createdAt,
          revokedAt: apiKeys.revokedAt,
          keyPreview: sql<string>`CONCAT(SUBSTRING(${apiKeys.key}, 1, 16), '...')`,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, user.id))
        .orderBy(desc(apiKeys.createdAt));
    },
  );

  const stats = await Sentry.startSpan(
    { name: "db.select.userStats" },
    async () => {
      return await db
        .select({
          totalRequests: sql<number>`COUNT(*)::int`,
          totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
          totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
          totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
        })
        .from(requestLogs)
        .where(eq(requestLogs.userId, user.id));
    },
  );

  const recentLogs = await Sentry.startSpan(
    { name: "db.select.recentLogs" },
    async () => {
      return await db
        .select({
          id: requestLogs.id,
          model: requestLogs.model,
          totalTokens: requestLogs.totalTokens,
          timestamp: requestLogs.timestamp,
          duration: requestLogs.duration,
          ip: requestLogs.ip,
        })
        .from(requestLogs)
        .where(eq(requestLogs.userId, user.id))
        .orderBy(desc(requestLogs.timestamp))
        .limit(50);
    },
  );

  return c.html(
    <Dashboard
      user={user}
      apiKeys={keys}
      stats={
        stats[0] || {
          totalRequests: 0,
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
        }
      }
      recentLogs={recentLogs}
      allowedLanguageModels={allowedLanguageModels}
      allowedEmbeddingModels={allowedEmbeddingModels}
      enforceIdv={env.ENFORCE_IDV || false}
    />,
  );
});

export default dashboard;
