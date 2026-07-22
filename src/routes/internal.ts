import { arktypeValidator } from "@hono/arktype-validator";
import * as Sentry from "@sentry/bun";
import { type } from "arktype";
import { and, eq, gt } from "drizzle-orm";
import { type Context, Hono, type Next } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { apiKeys, sessions, users } from "../db/schema";
import { env } from "../env";
import {
  clearUserReviewStatus,
  getUserFlagSettings,
  getUserViolations,
  setUserFlagSettings,
} from "../lib/review";

const internal = new Hono();

const requireInternalAuth = async (c: Context, next: Next) => {
  const sessionToken = getCookie(c, "session_token");

  if (sessionToken) {
    const [result] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.token, sessionToken),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (result?.user.isAdmin) {
      await next();
      return;
    }
  }

  const authHeader = c.req.header("Authorization") || "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;
  const token = bearer || c.req.header("X-Internal-Token") || "";

  if (!env.INTERNAL_API_KEY) {
    throw new HTTPException(500, {
      message: "Internal API key is not configured",
    });
  }

  if (token !== env.INTERNAL_API_KEY) {
    throw new HTTPException(401, {
      message: "Internal authentication required",
    });
  }

  await next();
};

internal.use("*", requireInternalAuth);

const revokeSchema = type({ token: "string" });

internal.post("/revoke", arktypeValidator("json", revokeSchema), async (c) => {
  const { token } = c.req.valid("json");

  const [result] = await Sentry.startSpan(
    { name: "db.select.apiKeyWithOwner" },
    async () => {
      return await db
        .select({
          apiKeyId: apiKeys.id,
          keyName: apiKeys.name,
          revokedAt: apiKeys.revokedAt,
          ownerEmail: users.email,
        })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .where(eq(apiKeys.key, token))
        .limit(1);
    },
  );

  if (!result) {
    return c.json({ success: false }, 400);
  }

  if (result.revokedAt) {
    return c.json({ success: false }, 400);
  }

  await Sentry.startSpan({ name: "db.update.revokeApiKey" }, async () => {
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, result.apiKeyId));
  });

  return c.json({
    success: true,
    owner_email: result.ownerEmail,
    key_name: result.keyName,
  });
});

const userIdParam = type({ userId: "string" });

internal.get(
  "/users/:userId/violations",
  arktypeValidator("param", userIdParam),
  async (c) => {
    const { userId } = c.req.valid("param");
    const violations = await getUserViolations(userId);
    return c.json({ violations });
  },
);

internal.get(
  "/users/:userId/flag-settings",
  arktypeValidator("param", userIdParam),
  async (c) => {
    const { userId } = c.req.valid("param");
    const settings = await getUserFlagSettings(userId);
    return c.json(settings);
  },
);

const flagSettingsUpdate = type({
  optInForcedReview: "boolean",
});

internal.put(
  "/users/:userId/flag-settings",
  arktypeValidator("param", userIdParam),
  arktypeValidator("json", flagSettingsUpdate),
  async (c) => {
    const { userId } = c.req.valid("param");
    const { optInForcedReview } = c.req.valid("json");
    await setUserFlagSettings(userId, optInForcedReview);
    return c.json({ success: true });
  },
);

internal.post(
  "/users/:userId/clear-review",
  arktypeValidator("param", userIdParam),
  async (c) => {
    const { userId } = c.req.valid("param");
    await clearUserReviewStatus(userId);
    return c.json({ success: true });
  },
);

export default internal;
