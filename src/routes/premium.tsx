import * as Sentry from "@sentry/bun";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { premiumAccessRequests } from "../db/schema";
import {
  generateReferenceCode,
  getDonationUrl,
  getPremiumConfig,
  isPremiumModel,
  checkUserAccess,
} from "../lib/premium";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";

const premium = new Hono<{ Variables: AppVariables }>();

premium.use("*", requireAuth);
premium.post("/request/:modelId{.+}", async (c) => {
  const user = c.get("user");
  const modelId = c.req.param("modelId");

  if (!isPremiumModel(modelId)) {
    throw new HTTPException(400, {
      message: "This model does not require premium access",
    });
  }


  const hasAccess = await checkUserAccess(user.id, modelId);
  if (hasAccess) {
    throw new HTTPException(400, {
      message: "You already have access to this model",
    });
  }

  const [existingRequest] = await Sentry.startSpan(
    { name: "db.select.existingPremiumRequest" },
    async () => {
      return await db
        .select()
        .from(premiumAccessRequests)
        .where(
          and(
            eq(premiumAccessRequests.userId, user.id),
            eq(premiumAccessRequests.modelId, modelId),
            eq(premiumAccessRequests.status, "pending"),
          ),
        )
        .limit(1);
    },
  );

  if (existingRequest) {
    const config = getPremiumConfig(modelId);
    return c.json({
      requestId: existingRequest.id,
      referenceCode: existingRequest.referenceCode,
      donationUrl: getDonationUrl(),
      requiredAmount: config?.requiredDonationCents,
      message: "You already have a pending request for this model",
    });
  }

  const referenceCode = generateReferenceCode();

  const [request] = await Sentry.startSpan(
    { name: "db.insert.premiumAccessRequest" },
    async () => {
      return await db
        .insert(premiumAccessRequests)
        .values({
          userId: user.id,
          modelId,
          referenceCode,
          status: "pending",
        })
        .returning();
    },
  );

  const config = getPremiumConfig(modelId);

  return c.json({
    requestId: request.id,
    referenceCode: request.referenceCode,
    donationUrl: getDonationUrl(),
    requiredAmount: config?.requiredDonationCents,
    message: "Request created successfully",
  });
});

premium.get("/my-requests", async (c) => {
  const user = c.get("user");

  const requests = await Sentry.startSpan(
    { name: "db.select.userPremiumRequests" },
    async () => {
      return await db
        .select()
        .from(premiumAccessRequests)
        .where(eq(premiumAccessRequests.userId, user.id))
        .orderBy(desc(premiumAccessRequests.requestedAt));
    },
  );

  return c.json({ requests });
});

premium.get("/check/:modelId{.+}", async (c) => {
  const user = c.get("user");
  const modelId = c.req.param("modelId");

  const hasAccess = await checkUserAccess(user.id, modelId);
  const config = getPremiumConfig(modelId);

  return c.json({
    modelId,
    hasAccess,
    isPremium: isPremiumModel(modelId),
    config,
  });
});

export default premium;
