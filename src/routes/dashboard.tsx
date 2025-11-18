import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { requireAuth } from "../middleware/auth";
import { db } from "../db";
import { apiKeys, requestLogs, sessions } from "../db/schema";
import { eq, desc, sql, and, gt } from "drizzle-orm";
import { Home } from "../views/home";
import { Dashboard } from "../views/dashboard";
import { Global } from "../views/global";
import { Docs } from "../views/docs";
import { ImageGenerationDocs } from "../views/docs-image-generation";
import {
  getAllowedLanguageModels,
  getAllowedEmbeddingModels,
  env,
} from "../env";
import type { AppVariables } from "../types";

const dashboard = new Hono<{ Variables: AppVariables }>();

dashboard.get("/", async (c) => {
  // Check if user has a valid session and redirect to dashboard
  const sessionToken = getCookie(c, "session_token");

  if (sessionToken) {
    // Validate session is not expired
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.token, sessionToken),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (session) {
      return c.redirect("/dashboard");
    }
  }

  const allowedLanguageModels = getAllowedLanguageModels();
  return c.html(<Home models={allowedLanguageModels} />);
});

dashboard.get("/dashboard", requireAuth, async (c) => {
  const user = c.get("user");

  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
      keyPreview: sql`CONCAT(SUBSTRING(${apiKeys.key}, 1, 16), '...')`,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id))
    .orderBy(desc(apiKeys.createdAt));

  const stats = await db
    .select({
      totalRequests: sql<number>`COUNT(*)::int`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
    })
    .from(requestLogs)
    .where(eq(requestLogs.userId, user.id));

  const recentLogs = await db
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

  const allowedLanguageModels = getAllowedLanguageModels();
  const allowedEmbeddingModels = getAllowedEmbeddingModels();

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
      enforceIdv={env.ENFORCE_IDV}
    />,
  );
});

dashboard.get("/global", requireAuth, async (c) => {
  const user = c.get("user");

  // Global stats across ALL users
  const globalStats = await db
    .select({
      totalRequests: sql<number>`COUNT(*)::int`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
    })
    .from(requestLogs);

  // Per-model stats across ALL users
  const modelStats = await db
    .select({
      model: requestLogs.model,
      totalRequests: sql<number>`COUNT(*)::int`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
    })
    .from(requestLogs)
    .groupBy(requestLogs.model)
    .orderBy(desc(sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)`));

  return c.html(
    <Global
      user={user}
      globalStats={
        globalStats[0] || {
          totalRequests: 0,
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
        }
      }
      modelStats={modelStats}
    />,
  );
});

dashboard.get("/docs", requireAuth, async (c) => {
  const user = c.get("user");
  const allowedLanguageModels = getAllowedLanguageModels();
  const allowedEmbeddingModels = getAllowedEmbeddingModels();

  return c.html(
    <Docs
      user={user}
      allowedLanguageModels={allowedLanguageModels}
      allowedEmbeddingModels={allowedEmbeddingModels}
    />,
  );
});

dashboard.get("/docs/image-generation", requireAuth, async (c) => {
  const user = c.get("user");
  const allowedLanguageModels = getAllowedLanguageModels();

  return c.html(
    <ImageGenerationDocs
      user={user}
      allowedLanguageModels={allowedLanguageModels}
    />,
  );
});

export default dashboard;
