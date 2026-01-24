import * as Sentry from "@sentry/bun";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Keys } from "../views/keys";

const keys = new Hono<{ Variables: AppVariables }>();

keys.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const userKeys = await Sentry.startSpan(
    { name: "db.select.apiKeys" },
    async () => {
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
    },
  );

  return c.html(<Keys user={user} apiKeys={userKeys} />);
});

export default keys;
