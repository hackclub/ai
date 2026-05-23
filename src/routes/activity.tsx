import * as Sentry from "@sentry/bun";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { apiKeys, requestLogs } from "../db/schema";
import { fetchAllModels } from "../lib/models";
import { getDailySpending, getUserStats } from "../lib/stats";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import {
  Activity,
  LoadMoreRequestsButton,
  RecentRequestsRows,
} from "../views/activity";

const activity = new Hono<{ Variables: AppVariables }>();
const PAGE_SIZE = 50;

const getModelNameById = async () => {
  try {
    const { languageModels, imageModels, embeddingModels } =
      await Sentry.startSpan({ name: "fetch.models" }, () => fetchAllModels());
    return new Map(
      [...languageModels, ...imageModels, ...embeddingModels].map((model) => [
        model.id,
        model.name || model.id,
      ]),
    );
  } catch {
    return new Map<string, string>();
  }
};

const getRecentLogs = async (
  userId: string,
  before?: { timestamp: Date; id: string },
) => {
  const rows = await Sentry.startSpan({ name: "db.select.recentLogs" }, () =>
    db
      .select({
        id: requestLogs.id,
        model: requestLogs.model,
        promptTokens: requestLogs.promptTokens,
        completionTokens: requestLogs.completionTokens,
        totalTokens: requestLogs.totalTokens,
        timestamp: requestLogs.timestamp,
        duration: requestLogs.duration,
        ip: requestLogs.ip,
        response: requestLogs.response,
        apiKeyName: apiKeys.name,
      })
      .from(requestLogs)
      .innerJoin(apiKeys, eq(requestLogs.apiKeyId, apiKeys.id))
      .where(
        before
          ? and(
              eq(requestLogs.userId, userId),
              or(
                lt(requestLogs.timestamp, before.timestamp),
                and(
                  eq(requestLogs.timestamp, before.timestamp),
                  lt(requestLogs.id, before.id),
                ),
              ),
            )
          : eq(requestLogs.userId, userId),
      )
      .orderBy(desc(requestLogs.timestamp), desc(requestLogs.id))
      .limit(PAGE_SIZE + 1),
  );

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const modelNameById = await getModelNameById();

  return {
    hasMore,
    logs: page.map((row) => ({
      ...row,
      modelName: modelNameById.get(row.model) || row.model,
    })),
  };
};

activity.get("/activity", requireAuth, async (c) => {
  const user = c.get("user");

  const [stats, recent, dailySpending] = await Promise.all([
    getUserStats(user.id),
    getRecentLogs(user.id),
    getDailySpending(user.id),
  ]);

  return c.html(
    <Activity
      user={user}
      stats={stats}
      recentLogs={recent.logs}
      hasMoreRecentLogs={recent.hasMore}
      dailySpending={dailySpending}
    />,
  );
});

activity.get("/activity/requests", requireAuth, async (c) => {
  const user = c.get("user");
  const beforeTimestamp = c.req.query("before");
  const beforeId = c.req.query("beforeId");
  const beforeDate = beforeTimestamp ? new Date(beforeTimestamp) : null;

  if (!beforeDate || Number.isNaN(beforeDate.getTime()) || !beforeId) {
    return c.body(null, 400);
  }

  const recent = await getRecentLogs(user.id, {
    timestamp: beforeDate,
    id: beforeId,
  });

  return c.html(
    <>
      <RecentRequestsRows recentLogs={recent.logs} />
      <div
        id="load-more-requests"
        class="mt-4 flex justify-center"
        hx-swap-oob="outerHTML"
      >
        {recent.hasMore && <LoadMoreRequestsButton recentLogs={recent.logs} />}
      </div>
    </>,
  );
});

export default activity;
