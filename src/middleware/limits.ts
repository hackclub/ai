import * as Sentry from "@sentry/bun";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { SPENDING_LIMIT, SPENDING_WINDOW_MS } from "../routes/proxy/shared";
import type { AppVariables } from "../types";

export async function checkSpendingLimit(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  return Sentry.startSpan(
    { name: "middleware.checkSpendingLimit" },
    async () => {
      const user = c.get("user");
      const dailyLimit = parseFloat(user.spendingLimitUsd || "8");

      const now = new Date();
      const windowStart = new Date(now.getTime() - SPENDING_WINDOW_MS);
      const startOfDay = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );

      const [windowUsage] = await db
        .select({
          totalCost: sql<string>`COALESCE(SUM(${requestLogs.cost}), 0)`,
        })
        .from(requestLogs)
        .where(
          and(
            eq(requestLogs.userId, user.id),
            gte(requestLogs.timestamp, windowStart),
          ),
        );

      const [dailyUsage] = await db
        .select({
          totalCost: sql<string>`COALESCE(SUM(${requestLogs.cost}), 0)`,
        })
        .from(requestLogs)
        .where(
          and(
            eq(requestLogs.userId, user.id),
            gte(requestLogs.timestamp, startOfDay),
          ),
        );

      const windowSpent = parseFloat(windowUsage?.totalCost || "0");
      const dailySpent = parseFloat(dailyUsage?.totalCost || "0");

      if (windowSpent >= SPENDING_LIMIT) {
        throw new HTTPException(429, {
          message: `30-minute spending limit of $${SPENDING_LIMIT} reached. Need a higher limit? hey@mahadk.com`,
        });
      }

      if (dailySpent >= dailyLimit) {
        throw new HTTPException(429, {
          message: `Daily spending limit of $${dailyLimit} reached. Need a higher limit? hey@mahadk.com`,
        });
      }

      await next();
    },
  );
}
