import * as Sentry from "@sentry/bun";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import type { AppVariables } from "../types";

export async function checkSpendingLimit(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  return Sentry.startSpan(
    { name: "middleware.checkSpendingLimit" },
    async () => {
      const user = c.get("user");
      const limit = parseFloat(user.spendingLimitUsd || "8");

      const now = new Date();
      const startOfDay = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );

      const [usage] = await db
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

      const spent = parseFloat(usage?.totalCost || "0");

      if (spent >= limit) {
        throw new HTTPException(429, {
          message: `Daily spending limit of $${limit} reached. Need a higher limit? hey@mahadkc`,
        });
      }

      await next();
    },
  );
}
