import { Hono } from "hono";
import { getDailySpending, getGlobalStats, getModelStats, getApiStatus } from "../lib/stats";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Global } from "../views/global";

const global = new Hono<{ Variables: AppVariables }>();

global.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const [globalStats, modelStats, dailySpending, apiStatus] = await Promise.all([
    getGlobalStats(),
    getModelStats(),
    getDailySpending(user.id),
    getApiStatus(),
  ]);

  return c.html(
    <Global
      user={user}
      globalStats={globalStats}
      modelStats={modelStats}
      dailySpending={dailySpending}
      apiStatus={apiStatus}
    />,
  );
});

export default global;
