import * as Sentry from "@sentry/bun";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import { getDailySpending } from "../lib/stats";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Keys } from "../views/keys";

const keys = new Hono<{ Variables: AppVariables }>();

keys.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const [userKeys, dailySpending] = await Promise.all([
    Sentry.startSpan({ name: "db.select.apiKeys" }, async () => {
      return await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          createdAt: apiKeys.createdAt,
          keyPreview: sql<string>`CONCAT(SUBSTRING(${apiKeys.key}, 1, 24), '...')`,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))
        .orderBy(desc(apiKeys.createdAt));
    }),
    getDailySpending(user.id),
  ]);

  return c.html(
    <Keys user={user} apiKeys={userKeys} dailySpending={dailySpending} />,
  );
});

export default keys;
