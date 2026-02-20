import * as Sentry from "@sentry/bun";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import type { Stats } from "../types";

const statsSelect = {
  totalRequests: sql<number>`COUNT(*)::int`,
  totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens})::bigint, 0)`.mapWith(Number),
  totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens})::bigint, 0)`.mapWith(Number),
  totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens})::bigint, 0)`.mapWith(Number),
};

const defaultStats: Stats = {
  totalRequests: 0,
  totalTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
};

export async function getUserStats(userId: string): Promise<Stats> {
  const [stats] = await Sentry.startSpan({ name: "db.select.userStats" }, () =>
    db
      .select(statsSelect)
      .from(requestLogs)
      .where(eq(requestLogs.userId, userId)),
  );
  return stats || defaultStats;
}

export async function getGlobalStats(): Promise<Stats> {
  const [stats] = await Sentry.startSpan(
    { name: "db.select.globalStats" },
    () => db.select(statsSelect).from(requestLogs),
  );
  return stats || defaultStats;
}

type ModelStats = Stats & { model: string };

export async function getModelStats(): Promise<ModelStats[]> {
  return Sentry.startSpan({ name: "db.select.modelStats" }, () =>
    db
      .select({
        model: requestLogs.model,
        ...statsSelect,
      })
      .from(requestLogs)
      .groupBy(requestLogs.model)
      .orderBy(desc(sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)`)),
  );
}

export async function getDailySpending(userId: string): Promise<number> {
  const now = new Date();
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const [result] = await Sentry.startSpan(
    { name: "db.select.dailySpending" },
    () =>
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
  );

  return parseFloat(result?.totalCost || "0");
}
