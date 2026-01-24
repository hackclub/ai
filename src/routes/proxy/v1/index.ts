import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";

import { db } from "../../../db";
import { requestLogs } from "../../../db/schema";
import { env } from "../../../env";
import {
  fetchEmbeddingModels,
  fetchImageModels,
  fetchLanguageModels,
} from "../../../lib/models";
import { blockAICodingAgents, requireApiKey } from "../../../middleware/auth";
import type { AppVariables } from "../../../types";
import { standardLimiter } from "../shared";
import general from "./general";
import moderations from "./moderations";
import replicate from "./replicate";

const proxy = new Hono<{ Variables: AppVariables }>();

proxy.use("*", bodyLimit({ maxSize: 40 * 1024 * 1024 }), blockAICodingAgents);
proxy.use("*", async (c, next) => {
  c.set(
    "ip",
    c.req.header("CF-Connecting-IP") ||
      (env.NODE_ENV === "development" ? "127.0.0.1" : "0.0.0.0"),
  );
  return next();
});
proxy.use("*", (c, next) =>
  c.req.path.includes("/models") ? next() : requireApiKey(c, next),
);

proxy.get("/models", etag(), async (c) => {
  const [l, i] = await Promise.all([fetchLanguageModels(), fetchImageModels()]);
  return c.json({ data: [...l.data, ...i.data] });
});

proxy.get("/embeddings/models", etag(), async (c) =>
  c.json(await fetchEmbeddingModels()),
);

proxy.get("/stats", standardLimiter, async (c) => {
  const [stats] = await db
    .select({
      totalRequests: sql<number>`COUNT(*)::int`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
    })
    .from(requestLogs)
    .where(eq(requestLogs.userId, c.get("user").id));
  return c.json(
    stats || {
      totalRequests: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    },
  );
});

proxy.route("/", general);
proxy.route("/", moderations);
proxy.route("/", replicate);

export default proxy;
