import * as Sentry from "@sentry/bun";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  contentViolations,
  requestLogs,
  userFlagSettings,
  users,
} from "../db/schema";
import { reviewConfig } from "../env";
import {
  getFlaggedCategories,
  type ModerationCategory,
  moderate,
} from "./moderation";

export type ReviewStatus = "normal" | "flagged" | "strict" | "banned";

interface ReviewDecision {
  shouldReview: boolean;
  blocking: boolean;
  sample: boolean;
}

type RecordViolationOptions = {
  requestLogId?: string | null;
  countTowardsUser?: boolean;
};

export function shouldReview(
  reviewStatus: ReviewStatus,
  optInForcedReview: boolean,
): ReviewDecision {
  if (reviewStatus === "banned") {
    return { shouldReview: false, blocking: true, sample: false };
  }

  if (reviewStatus === "strict" || optInForcedReview) {
    return { shouldReview: true, blocking: true, sample: false };
  }

  if (reviewStatus === "flagged") {
    return { shouldReview: true, blocking: false, sample: false };
  }

  const shouldSample = Math.random() < reviewConfig.sampleRate;
  return { shouldReview: shouldSample, blocking: false, sample: shouldSample };
}

function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

export async function recordViolationEvent(
  userId: string,
  type: "input" | "output",
  categories: ModerationCategory[],
  content: string,
  options?: RecordViolationOptions,
) {
  if (categories.length === 0) return;

  const eventId = crypto.randomUUID();
  const trimmedContent = content.substring(0, 1000);
  const contentHash = hashContent(content.substring(0, 500));
  const values = categories.map((category) => ({
    userId,
    requestLogId: options?.requestLogId || null,
    violationEventId: eventId,
    type,
    category,
    content: trimmedContent,
    contentHash,
  }));

  await db.insert(contentViolations).values(values);

  if (options?.countTowardsUser !== false) {
    await updateViolationCounts(userId);
  }
}

async function updateViolationCounts(userId: string) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [weekViolations] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${contentViolations.violationEventId})`,
    })
    .from(contentViolations)
    .where(
      and(
        eq(contentViolations.userId, userId),
        gte(contentViolations.createdAt, weekAgo),
        eq(contentViolations.dismissed, false),
      ),
    );

  const [monthViolations] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${contentViolations.violationEventId})`,
    })
    .from(contentViolations)
    .where(
      and(
        eq(contentViolations.userId, userId),
        gte(contentViolations.createdAt, monthAgo),
        eq(contentViolations.dismissed, false),
      ),
    );

  const weekCount = weekViolations?.count ?? 0;
  const monthCount = monthViolations?.count ?? 0;

  let newStatus: ReviewStatus = "normal";

  if (monthCount >= reviewConfig.monthlyThreshold) {
    newStatus = "banned";
  } else if (weekCount >= reviewConfig.strictThreshold) {
    newStatus = "strict";
  } else if (weekCount >= reviewConfig.weeklyThreshold) {
    newStatus = "flagged";
  }

  await db
    .update(users)
    .set({
      violationCountWeek: weekCount,
      violationCountMonth: monthCount,
      reviewStatus: newStatus,
      lastViolationAt: now,
    })
    .where(eq(users.id, userId));

  if (newStatus === "banned") {
    Sentry.captureMessage(`User banned due to content violations: ${userId}`, {
      extra: { weekCount, monthCount },
    });
  }
}

// Exported so admin actions can trigger a recount after dismissing records
export async function recomputeUserCounts(userId: string) {
  await updateViolationCounts(userId);
}

export async function reviewContent(
  userId: string,
  inputContent: string[],
  outputContent?: string,
  options?: {
    countTowardsUser?: boolean;
    requestLogId?: string | null;
    reviewInput?: boolean;
    reviewOutput?: boolean;
  },
) {
  try {
    const reviewInput = options?.reviewInput ?? true;
    const reviewOutput = options?.reviewOutput ?? true;

    if (reviewInput) {
      const inputResult = await moderate(inputContent);

      if (inputResult.flagged) {
        const categories = getFlaggedCategories(inputResult);
        await recordViolationEvent(
          userId,
          "input",
          categories,
          inputContent.join(" "),
          {
            countTowardsUser: options?.countTowardsUser,
            requestLogId: options?.requestLogId,
          },
        );
      }
    }

    if (reviewOutput && outputContent) {
      const outputResult = await moderate([outputContent]);

      if (outputResult.flagged) {
        const categories = getFlaggedCategories(outputResult);
        await recordViolationEvent(
          userId,
          "output",
          categories,
          outputContent,
          {
            countTowardsUser: options?.countTowardsUser,
            requestLogId: options?.requestLogId,
          },
        );
      }
    }
  } catch (error) {
    console.error("Review error:", error);
    Sentry.captureException(error);
  }
}

export async function getUserFlagSettings(userId: string) {
  const [settings] = await db
    .select()
    .from(userFlagSettings)
    .where(eq(userFlagSettings.userId, userId))
    .limit(1);

  if (!settings) {
    return { optInForcedReview: false };
  }

  return settings;
}

export async function setUserFlagSettings(
  userId: string,
  optInForcedReview: boolean,
) {
  await db
    .insert(userFlagSettings)
    .values({
      userId,
      optInForcedReview,
    })
    .onConflictDoUpdate({
      target: userFlagSettings.userId,
      set: {
        optInForcedReview,
        updatedAt: new Date(),
      },
    });
}

export async function getUserViolations(userId: string, limit = 50) {
  return await db
    .select()
    .from(contentViolations)
    .where(eq(contentViolations.userId, userId))
    .orderBy(desc(contentViolations.createdAt))
    .limit(limit);
}

export async function getUserViolationsWithLogs(userId: string, limit = 50) {
  return await db
    .select({
      violation: contentViolations,
      requestLog: requestLogs,
    })
    .from(contentViolations)
    .leftJoin(requestLogs, eq(contentViolations.requestLogId, requestLogs.id))
    .where(eq(contentViolations.userId, userId))
    .orderBy(desc(contentViolations.createdAt))
    .limit(limit);
}

export async function getUserViolationStats(userId: string) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [weekViolations] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${contentViolations.violationEventId})`,
    })
    .from(contentViolations)
    .where(
      and(
        eq(contentViolations.userId, userId),
        gte(contentViolations.createdAt, weekAgo),
        eq(contentViolations.dismissed, false),
      ),
    );

  const [monthViolations] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${contentViolations.violationEventId})`,
    })
    .from(contentViolations)
    .where(
      and(
        eq(contentViolations.userId, userId),
        gte(contentViolations.createdAt, monthAgo),
        eq(contentViolations.dismissed, false),
      ),
    );

  const [totalViolations] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${contentViolations.violationEventId})`,
    })
    .from(contentViolations)
    .where(
      and(
        eq(contentViolations.userId, userId),
        eq(contentViolations.dismissed, false),
      ),
    );

  const [user] = await db
    .select({
      reviewStatus: users.reviewStatus,
      violationCountWeek: users.violationCountWeek,
      violationCountMonth: users.violationCountMonth,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    reviewStatus: user?.reviewStatus || "normal",
    violationsThisWeek: weekViolations?.count ?? 0,
    violationsThisMonth: monthViolations?.count ?? 0,
    totalViolations: totalViolations?.count ?? 0,
    weeklyThreshold: reviewConfig.weeklyThreshold,
    strictThreshold: reviewConfig.strictThreshold,
    monthlyThreshold: reviewConfig.monthlyThreshold,
  };
}

export async function clearUserReviewStatus(userId: string) {
  await db
    .update(users)
    .set({
      reviewStatus: "normal",
      violationCountWeek: 0,
      violationCountMonth: 0,
      lastViolationAt: null,
    })
    .where(eq(users.id, userId));
}

export async function getAllViolations(limit = 500) {
  return await db
    .select({
      violation: contentViolations,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        reviewStatus: users.reviewStatus,
      },
    })
    .from(contentViolations)
    .leftJoin(users, eq(contentViolations.userId, users.id))
    .orderBy(desc(contentViolations.createdAt))
    .limit(limit);
}
