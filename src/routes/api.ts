import { Hono } from "hono";
import * as Sentry from "@sentry/bun";
import { arktypeValidator } from "@hono/arktype-validator";
import { type } from "arktype";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth";
import { db } from "../db";
import { apiKeys, requestLogs } from "../db/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import type { AppVariables } from "../types";

const api = new Hono<{ Variables: AppVariables }>();

api.use("*", requireAuth);

const createKeySchema = type({ name: "1<=string<=100" });

api.post("/keys", arktypeValidator("json", createKeySchema), async (c) => {
  return Sentry.startSpan({ name: "POST /keys" }, async () => {
    const user = c.get("user");
    const { name } = c.req.valid("json");

    const existingKeys = await Sentry.startSpan(
      { name: "db.select.apiKeysCount" },
      async () => {
        return await db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(apiKeys)
          .where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)));
      },
    );

    if (existingKeys[0].count >= 50) {
      throw new HTTPException(400, {
        message: "Maximum API key limit reached",
      });
    }

    const initial = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(
      /-/g,
      "",
    );
    const key = `sk-hc-v1-${initial}`;

    const [apiKey] = await Sentry.startSpan(
      { name: "db.insert.apiKeys" },
      async () => {
        return await db
          .insert(apiKeys)
          .values({
            userId: user.id,
            key,
            name: name.trim(),
          })
          .returning();
      },
    );

    return c.json({ key: apiKey.key, name: apiKey.name, id: apiKey.id });
  });
});

api.get("/keys", async (c) => {
  return Sentry.startSpan({ name: "GET /keys" }, async () => {
    const user = c.get("user");

    const keys = await Sentry.startSpan(
      { name: "db.select.apiKeys" },
      async () => {
        return await db
          .select({
            id: apiKeys.id,
            name: apiKeys.name,
            createdAt: apiKeys.createdAt,
            revokedAt: apiKeys.revokedAt,
            keyPreview: sql`CONCAT(SUBSTRING(${apiKeys.key}, 1, 10), '...')`,
          })
          .from(apiKeys)
          .where(eq(apiKeys.userId, user.id))
          .orderBy(desc(apiKeys.createdAt));
      },
    );

    return c.json(keys);
  });
});

api.delete("/keys/:id", async (c) => {
  return Sentry.startSpan({ name: "DELETE /keys/:id" }, async () => {
    const user = c.get("user");
    const keyId = c.req.param("id");

    const [apiKey] = await Sentry.startSpan(
      { name: "db.select.apiKeyById" },
      async () => {
        return await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, user.id)))
          .limit(1);
      },
    );

    if (!apiKey) {
      throw new HTTPException(404, { message: "Operation failed" });
    }

    await Sentry.startSpan({ name: "db.update.revokeApiKey" }, async () => {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, keyId));
    });

    return c.json({ success: true });
  });
});

api.get("/stats", async (c) => {
  return Sentry.startSpan({ name: "GET /stats" }, async () => {
    const user = c.get("user");

    const stats = await Sentry.startSpan(
      { name: "db.select.userStats" },
      async () => {
        return await db
          .select({
            totalRequests: sql<number>`COUNT(*)::int`,
            totalTokens: sql<number>`SUM(${requestLogs.totalTokens})::int`,
            totalPromptTokens: sql<number>`SUM(${requestLogs.promptTokens})::int`,
            totalCompletionTokens: sql<number>`SUM(${requestLogs.completionTokens})::int`,
          })
          .from(requestLogs)
          .where(eq(requestLogs.userId, user.id));
      },
    );

    const recentLogs = await Sentry.startSpan(
      { name: "db.select.recentLogs" },
      async () => {
        return await db
          .select({
            id: requestLogs.id,
            model: requestLogs.model,
            totalTokens: requestLogs.totalTokens,
            timestamp: requestLogs.timestamp,
            duration: requestLogs.duration,
            ip: requestLogs.ip,
          })
          .from(requestLogs)
          .where(eq(requestLogs.userId, user.id))
          .orderBy(desc(requestLogs.timestamp))
          .limit(50);
      },
    );

    return c.json({
      stats: stats[0],
      recentLogs,
    });
  });
});

export default api;
