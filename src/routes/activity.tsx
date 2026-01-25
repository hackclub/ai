import * as Sentry from "@sentry/bun";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { getUserStats } from "../lib/stats";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Activity } from "../views/activity";

const activity = new Hono<{ Variables: AppVariables }>();

activity.get("/activity", requireAuth, async (c) => {
  const user = c.get("user");

  const [stats, recentLogs] = await Promise.all([
    getUserStats(user.id),
    Sentry.startSpan({ name: "db.select.recentLogs" }, () =>
      db
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
        .limit(50),
    ),
  ]);

  return c.html(<Activity user={user} stats={stats} recentLogs={recentLogs} />);
});

export default activity;
