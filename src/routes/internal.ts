import { arktypeValidator } from "@hono/arktype-validator";
import * as Sentry from "@sentry/bun";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { apiKeys, users } from "../db/schema";
import { env } from "../env";

const internal = new Hono();

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

export default internal;
