import * as Sentry from "@sentry/bun";
import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import { allowedLanguageModels, env } from "../env";
import { isFeatureEnabled } from "../lib/posthog";
import {
  getUserFlagSettings,
  getUserViolationStats,
  getUserViolations,
} from "../lib/review";
import { getDailySpending, getUserStats } from "../lib/stats";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { BannedView } from "../views/banned";
import { Dashboard } from "../views/dashboard";
import { Home } from "../views/home";
import { ViolationsView } from "../views/moderation";

const dashboard = new Hono<{ Variables: AppVariables }>();

dashboard.get("/", async (c) => {
  const sessionToken = getCookie(c, "session_token");

  if (sessionToken) {
    const [result] = await Sentry.startSpan({ name: "db.select.session" }, () =>
      db
        .select({
          session: sessions,
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
        .limit(1),
    );

    if (result) {
      if (result.user.reviewStatus !== "banned") {
        return c.redirect("/dashboard");
      } else {
        return c.redirect("/banned");
      }
    }
  }

  return c.html(<Home models={allowedLanguageModels} />);
});

dashboard.get("/banned", async (c) => {
  const sessionToken = getCookie(c, "session_token");

  if (!sessionToken) {
    return c.redirect("/");
  }

  const [result] = await Sentry.startSpan({ name: "db.select.session" }, () =>
    db
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
      .limit(1),
  );

  if (!result) {
    return c.redirect("/");
  }

  const user = result.user;
  if (user.reviewStatus !== "banned") {
    return c.redirect("/dashboard");
  }

  const violations = await getUserViolations(user.id, 5);

  return c.html(<BannedView user={user} violations={violations} />);
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

dashboard.get("/dashboard/violations", requireAuth, async (c) => {
  const user = c.get("user");

  const [stats, violations, flagSettings] = await Promise.all([
    getUserViolationStats(user.id),
    getUserViolations(user.id, 50),
    getUserFlagSettings(user.id),
  ]);

  return c.html(
    <ViolationsView
      user={user}
      stats={stats}
      violations={violations}
      flagSettings={flagSettings}
    />,
  );
});

export default dashboard;
