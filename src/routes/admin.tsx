import * as Sentry from "@sentry/bun";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import {
  premiumAccessRequests,
  premiumModelAccess,
  users,
} from "../db/schema";
import { getAllPremiumModels, getPremiumConfig } from "../lib/premium";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { AdminDashboard } from "../views/admin";

const admin = new Hono<{ Variables: AppVariables }>();


const requireAdmin = async (
  c: Parameters<typeof requireAuth>[0],
  next: Parameters<typeof requireAuth>[1],
) => {
  const user = c.get("user");
  if (!user?.isAdmin) {
    throw new HTTPException(403, { message: "Admin access required" });
  }
  return next();
};

admin.use("*", requireAuth);
admin.use("*", requireAdmin);

admin.get("/", async (c) => {
  const user = c.get("user");

  const pendingRequests = await Sentry.startSpan(
    { name: "db.select.pendingRequests" },
    async () => {
      return await db
        .select({
          id: premiumAccessRequests.id,
          userId: premiumAccessRequests.userId,
          modelId: premiumAccessRequests.modelId,
          status: premiumAccessRequests.status,
          referenceCode: premiumAccessRequests.referenceCode,
          requestedAt: premiumAccessRequests.requestedAt,
          reviewedAt: premiumAccessRequests.reviewedAt,
          reviewedBy: premiumAccessRequests.reviewedBy,
          notes: premiumAccessRequests.notes,
          userName: users.name,
          userEmail: users.email,
          userSlackId: users.slackId,
        })
        .from(premiumAccessRequests)
        .innerJoin(users, eq(premiumAccessRequests.userId, users.id))
        .where(eq(premiumAccessRequests.status, "pending"))
        .orderBy(desc(premiumAccessRequests.requestedAt));
    },
  );

  const recentReviewed = await Sentry.startSpan(
    { name: "db.select.recentReviewedRequests" },
    async () => {
      return await db
        .select({
          id: premiumAccessRequests.id,
          userId: premiumAccessRequests.userId,
          modelId: premiumAccessRequests.modelId,
          status: premiumAccessRequests.status,
          referenceCode: premiumAccessRequests.referenceCode,
          requestedAt: premiumAccessRequests.requestedAt,
          reviewedAt: premiumAccessRequests.reviewedAt,
          reviewedBy: premiumAccessRequests.reviewedBy,
          notes: premiumAccessRequests.notes,
          userName: users.name,
          userEmail: users.email,
          userSlackId: users.slackId,
        })
        .from(premiumAccessRequests)
        .innerJoin(users, eq(premiumAccessRequests.userId, users.id))
        .where(
          and(
            eq(premiumAccessRequests.status, "approved"),
          ),
        )
        .orderBy(desc(premiumAccessRequests.reviewedAt))
        .limit(20);
    },
  );

  const premiumModels = getAllPremiumModels();

  return c.html(
    <AdminDashboard
      user={user}
      pendingRequests={pendingRequests}
      recentReviewed={recentReviewed}
      premiumModels={premiumModels}
    />,
  );
});

admin.post("/requests/:id/approve", async (c) => {
  const user = c.get("user");
  const requestId = c.req.param("id");

  const [request] = await Sentry.startSpan(
    { name: "db.select.premiumRequest" },
    async () => {
      return await db
        .select()
        .from(premiumAccessRequests)
        .where(eq(premiumAccessRequests.id, requestId))
        .limit(1);
    },
  );

  if (!request) {
    throw new HTTPException(404, { message: "Request not found" });
  }

  if (request.status !== "pending") {
    throw new HTTPException(400, { message: "Request already processed" });
  }

  await Sentry.startSpan(
    { name: "db.update.approveRequest" },
    async () => {
      await db
        .update(premiumAccessRequests)
        .set({
          status: "approved",
          reviewedAt: new Date(),
          reviewedBy: user.name || user.slackId,
        })
        .where(eq(premiumAccessRequests.id, requestId));
    },
  );

  await Sentry.startSpan(
    { name: "db.insert.premiumAccess" },
    async () => {
      await db.insert(premiumModelAccess).values({
        userId: request.userId,
        modelId: request.modelId,
        grantedBy: "donation",
        requestId: request.id,
      });
    },
  );

  return c.json({ success: true });
});

admin.post("/requests/:id/reject", async (c) => {
  const user = c.get("user");
  const requestId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { notes?: string };

  const [request] = await Sentry.startSpan(
    { name: "db.select.premiumRequest" },
    async () => {
      return await db
        .select()
        .from(premiumAccessRequests)
        .where(eq(premiumAccessRequests.id, requestId))
        .limit(1);
    },
  );

  if (!request) {
    throw new HTTPException(404, { message: "Request not found" });
  }

  if (request.status !== "pending") {
    throw new HTTPException(400, { message: "Request already processed" });
  }

  await Sentry.startSpan(
    { name: "db.update.rejectRequest" },
    async () => {
      await db
        .update(premiumAccessRequests)
        .set({
          status: "rejected",
          reviewedAt: new Date(),
          reviewedBy: user.name || user.slackId,
          notes: body.notes,
        })
        .where(eq(premiumAccessRequests.id, requestId));
    },
  );

  return c.json({ success: true });
});

admin.post("/grant", async (c) => {
  const user = c.get("user");
  const body = await c.req.json() as { userId: string; modelId: string };

  if (!body.userId || !body.modelId) {
    throw new HTTPException(400, { message: "userId and modelId required" });
  }

  const config = getPremiumConfig(body.modelId);
  if (!config) {
    throw new HTTPException(400, { message: "Invalid premium model" });
  }

  // Check if user exists
  const [targetUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, body.userId))
    .limit(1);

  if (!targetUser) {
    throw new HTTPException(404, { message: "User not found" });
  }

  // Grant access
  await Sentry.startSpan(
    { name: "db.insert.manualGrant" },
    async () => {
      await db.insert(premiumModelAccess).values({
        userId: body.userId,
        modelId: body.modelId,
        grantedBy: "admin_grant",
      });
    },
  );

  return c.json({ success: true });
});

// Get requests list as HTML partial for htmx
admin.get("/requests/partial", async (c) => {
  const pendingRequests = await Sentry.startSpan(
    { name: "db.select.pendingRequestsPartial" },
    async () => {
      return await db
        .select({
          id: premiumAccessRequests.id,
          userId: premiumAccessRequests.userId,
          modelId: premiumAccessRequests.modelId,
          status: premiumAccessRequests.status,
          referenceCode: premiumAccessRequests.referenceCode,
          requestedAt: premiumAccessRequests.requestedAt,
          userName: users.name,
          userEmail: users.email,
          userSlackId: users.slackId,
        })
        .from(premiumAccessRequests)
        .innerJoin(users, eq(premiumAccessRequests.userId, users.id))
        .where(eq(premiumAccessRequests.status, "pending"))
        .orderBy(desc(premiumAccessRequests.requestedAt));
    },
  );

  return c.html(
    <PendingRequestsTable requests={pendingRequests} />,
  );
});

const PendingRequestsTable = ({
  requests,
}: {
  requests: Array<{
    id: string;
    modelId: string;
    referenceCode: string;
    requestedAt: Date;
    userName: string | null;
    userEmail: string | null;
    userSlackId: string;
  }>;
}) => {
  if (requests.length === 0) {
    return (
      <div class="text-center py-8 text-brand-text">
        No pending requests
      </div>
    );
  }

  return (
    <div class="overflow-x-auto border-2 border-brand-border bg-brand-surface rounded-2xl">
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b-2 border-brand-border bg-brand-bg/50">
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              User
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Model
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Reference Code
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Requested
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {requests.map((req) => (
            <tr class="border-b border-brand-border/50 hover:bg-brand-bg/30 transition-colors">
              <td class="py-3 px-4 text-sm text-brand-text">
                <div class="font-medium">{req.userName || "Unknown"}</div>
                <div class="text-xs text-brand-text/70">{req.userEmail || req.userSlackId}</div>
              </td>
              <td class="py-3 px-4 text-sm font-mono text-brand-primary">
                {req.modelId}
              </td>
              <td class="py-3 px-4">
                <code class="bg-brand-bg px-2 py-1 rounded text-xs font-mono text-amber-400 border border-amber-500/30">
                  {req.referenceCode}
                </code>
              </td>
              <td class="py-3 px-4 text-sm text-brand-text">
                {new Date(req.requestedAt).toLocaleDateString()}
              </td>
              <td class="py-3 px-4">
                <div class="flex gap-2">
                  <button
                    type="button"
                    x-on:click={`approveRequest('${req.id}')`}
                    class="px-3 py-1.5 text-xs font-medium rounded-full bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20 transition-all"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    x-on:click={`rejectRequest('${req.id}')`}
                    class="px-3 py-1.5 text-xs font-medium rounded-full bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-all"
                  >
                    Reject
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default admin;
