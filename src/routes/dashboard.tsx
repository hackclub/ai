import * as Sentry from "@sentry/bun";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { db } from "../db";
import { requestLogs, sessions } from "../db/schema";
import { allowedLanguageModels, env } from "../env";
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

  return c.html(
    <Dashboard
      user={user}
      stats={
        stats[0] || {
          totalRequests: 0,
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
        }
      }
      enforceIdv={env.ENFORCE_IDV || false}
    />,
  );
});

export default dashboard;
