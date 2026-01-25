import { Hono } from "hono";
import { getGlobalStats, getModelStats } from "../lib/stats";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Global } from "../views/global";

const global = new Hono<{ Variables: AppVariables }>();

global.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const [globalStats, modelStats] = await Promise.all([
    getGlobalStats(),
    getModelStats(),
  ]);

  return c.html(
    <Global user={user} globalStats={globalStats} modelStats={modelStats} />,
  );
});

export default global;
