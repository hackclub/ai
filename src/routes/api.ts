import { arktypeValidator } from "@hono/arktype-validator";
import * as Sentry from "@sentry/bun";
import { type } from "arktype";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import { requireAuth } from "../middleware/auth";
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
      throw new HTTPException(400, { message: "Operation failed" });
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

export default api;
