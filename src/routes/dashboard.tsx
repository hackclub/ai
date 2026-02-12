import * as Sentry from "@sentry/bun";
import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { db } from "../db";
import { sessions } from "../db/schema";
import { allowedLanguageModels, env } from "../env";
import { isFeatureEnabled } from "../lib/posthog";
import { getDailySpending, getUserStats } from "../lib/stats";
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
      () =>
        db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.token, sessionToken),
              gt(sessions.expiresAt, new Date()),
            ),
          )
          .limit(1),
    );

    if (session) {
      return c.redirect("/dashboard");
    }
  }

  return c.html(<Home models={allowedLanguageModels} />);
});

dashboard.get("/dashboard", requireAuth, async (c) => {
  const user = c.get("user");

  const [stats, replicateEnabled, dailySpending] = await Promise.all([
    getUserStats(user.id),
    isFeatureEnabled(user, "enable_replicate"),
    getDailySpending(user.id),
  ]);

  return c.html(
    <Dashboard
      user={user}
      stats={stats}
      enforceIdv={env.ENFORCE_IDV || false}
      replicateEnabled={replicateEnabled}
      dailySpending={dailySpending}
    />,
  );
});

export default dashboard;
