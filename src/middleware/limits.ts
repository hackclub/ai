import * as Sentry from "@sentry/bun";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { pendingCharges, requestLogs } from "../db/schema";
import type { AppVariables } from "../types";

// Pending charges older than this are considered stale (request crashed
// without releasing the reservation) and excluded from the spending sum.
const PENDING_CHARGE_TTL_MS = 15 * 60 * 1000;

type Ctx = Context<{ Variables: AppVariables }>;

const startOfUtcDay = () => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

export const computeSpent = async (userId: string) => {
  const startOfDay = startOfUtcDay();
  const pendingCutoff = new Date(Date.now() - PENDING_CHARGE_TTL_MS);

  const [logged, pending] = await Promise.all([
    db
      .select({
        totalCost: sql<string>`COALESCE(SUM(${requestLogs.cost}), 0)`,
      })
      .from(requestLogs)
      .where(
        and(
          eq(requestLogs.userId, userId),
          gte(requestLogs.timestamp, startOfDay),
        ),
      ),
    db
      .select({
        totalCost: sql<string>`COALESCE(SUM(${pendingCharges.estimatedCost}), 0)`,
      })
      .from(pendingCharges)
      .where(
        and(
          eq(pendingCharges.userId, userId),
          gte(pendingCharges.createdAt, pendingCutoff),
        ),
      ),
  ]);

  return (
    parseFloat(logged[0]?.totalCost || "0") +
    parseFloat(pending[0]?.totalCost || "0")
  );
};

const overLimitMessage = (limit: number) =>
  `Daily spending limit of $${limit} reached. Need a higher limit? hey@mahadk.com`;

export async function checkSpendingLimit(c: Ctx, next: Next) {
  return Sentry.startSpan(
    { name: "middleware.checkSpendingLimit" },
    async () => {
      const apiKey = c.get("apiKey");
      if (apiKey?.isUnlimited) return next();

      const user = c.get("user");
      const limit = parseFloat(user.spendingLimitUsd || "4");

      const spent = await computeSpent(user.id);
      if (spent >= limit) {
        throw new HTTPException(429, { message: overLimitMessage(limit) });
      }

      await next();
    },
  );
}

/**
 * Reserve `estimatedCost` against the user's daily spending limit BEFORE
 * dispatching an upstream call. This closes the TOCTOU window where multiple
 * concurrent or long-running requests would each pass `checkSpendingLimit`
 * before any of them logged their cost.
 *
 * On success, stores the pending charge id on the context. The caller MUST
 * ensure `releasePendingCharge(c)` is invoked once the request completes
 * (logRequest does this automatically).
 */
export async function reserveCharge(c: Ctx, estimatedCost: number) {
  const apiKey = c.get("apiKey");
  if (apiKey?.isUnlimited) return;

  const user = c.get("user");
  const limit = parseFloat(user.spendingLimitUsd || "4");
  const estimate = Math.max(0, estimatedCost);

  const [row] = await db
    .insert(pendingCharges)
    .values({ userId: user.id, estimatedCost: String(estimate) })
    .returning({ id: pendingCharges.id });

  if (!row) {
    throw new HTTPException(500, { message: "Failed to reserve charge" });
  }

  c.set("pendingChargeId", row.id);

  const spent = await computeSpent(user.id);
  if (spent >= limit) {
    await releasePendingCharge(c);
    throw new HTTPException(429, { message: overLimitMessage(limit) });
  }
}

export async function releasePendingCharge(c: Ctx) {
  const id = c.get("pendingChargeId");
  if (!id) return;
  c.set("pendingChargeId", undefined);
  try {
    await db.delete(pendingCharges).where(eq(pendingCharges.id, id));
  } catch (e) {
    console.error("Failed to release pending charge:", e);
  }
}
