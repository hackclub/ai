import { Hono } from "hono";
import { etag } from "hono/etag";

import { env } from "../../../env";
import {
  fetchEmbeddingModels,
  fetchImageModels,
  fetchLanguageModels,
} from "../../../lib/models";
import { getUserStats } from "../../../lib/stats";
import { blockAICodingAgents, requireApiKey } from "../../../middleware/auth";
import type { AppVariables } from "../../../types";
import { standardLimiter } from "../shared";
import general from "./general";
import moderations from "./moderations";
import ocr from "./ocr";
import replicate from "./replicate";

const proxy = new Hono<{ Variables: AppVariables }>();

proxy.use("*", blockAICodingAgents);
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

proxy.get("/stats", standardLimiter, async (c) =>
  c.json(await getUserStats(c.get("user").id)),
);

proxy.route("/", general);
proxy.route("/", moderations);
proxy.route("/", ocr);
proxy.route("/", replicate);

export default proxy;
