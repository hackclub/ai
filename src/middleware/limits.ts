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
      // spendingLimitUsd is defined as numeric(10, 8) in schema (which I added),
      // effectively a string in JS Drizzle.
      // Default is "10".
      // We parse it to float for comparison.
      const limit = parseFloat(user.spendingLimitUsd || "10");

      if (limit <= 0) {
        // If limit is 0 or negative, maybe they are blocked or unlimited?
        // Assuming 0 means no limit? Or 0 means 0?
        // User said "if a user has spent $10... they can't send".
        // If limit is 0, they can't send anything?
        // Let's assume it's a hard limit.
      }

      const now = new Date();
      // Use UTC midnight
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
          message: `Daily spending limit of $${limit} reached.`,
        });
      }

      await next();
    },
  );
}
