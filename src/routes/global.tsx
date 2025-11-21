import * as Sentry from "@sentry/bun";
import { desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Global } from "../views/global";

const global = new Hono<{ Variables: AppVariables }>();

global.get("/", requireAuth, async (c) => {
  return Sentry.startSpan({ name: "GET /global" }, async () => {
    const user = c.get("user");

    // Global stats across ALL users
    const globalStats = await Sentry.startSpan(
      { name: "db.select.globalStats" },
      async () => {
        return await db
          .select({
            totalRequests: sql<number>`COUNT(*)::int`,
            totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
            totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
            totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
          })
          .from(requestLogs);
      },
    );

    // Per-model stats across ALL users
    const modelStats = await Sentry.startSpan(
      { name: "db.select.modelStats" },
      async () => {
        return await db
          .select({
            model: requestLogs.model,
            totalRequests: sql<number>`COUNT(*)::int`,
            totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
            totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
            totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
          })
          .from(requestLogs)
          .groupBy(requestLogs.model)
          .orderBy(
            desc(sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)`),
          );
      },
    );

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
});

export default global;
