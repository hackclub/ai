import * as Sentry from "@sentry/bun";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Activity } from "../views/activity";

const activity = new Hono<{ Variables: AppVariables }>();

activity.get("/activity", requireAuth, async (c) => {
  const user = c.get("user");

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
    <Activity
      user={user}
      stats={
        stats[0] || {
          totalRequests: 0,
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
        }
      }
      recentLogs={recentLogs}
    />,
  );
});

export default activity;
