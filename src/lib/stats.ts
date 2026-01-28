import * as Sentry from "@sentry/bun";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import type { Stats } from "../types";

const statsSelect = {
  totalRequests: sql<number>`COUNT(*)::int`,
  totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
  totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
  totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
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
