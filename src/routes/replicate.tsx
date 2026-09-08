import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isFeatureEnabled } from "../lib/posthog";
import { fetchReplicateCategories } from "../lib/replicate";
import { getDailySpending, getApiStatus } from "../lib/stats";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { ReplicateModels } from "../views/replicate-models";

const replicate = new Hono<{ Variables: AppVariables }>();

replicate.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const enabled = await isFeatureEnabled(user, "enable_replicate");
  if (!enabled) {
    throw new HTTPException(403, {
      message: "Replicate access is not enabled for your account",
    });
  }
  const [categories, dailySpending, apiStatus] = await Promise.all([
    fetchReplicateCategories(),
    getDailySpending(user.id),
    getApiStatus(),
  ]);
  return c.html(
    <ReplicateModels
      user={user}
      categories={categories}
      dailySpending={dailySpending}
      apiStatus={apiStatus}
    />,
  );
});

export default replicate;
