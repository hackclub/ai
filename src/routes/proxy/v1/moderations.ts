import { Hono } from "hono";
import { proxy } from "hono/proxy";

import { env } from "../../../env";
import { requireApiKey } from "../../../middleware/auth";
import type { AppVariables } from "../../../types";
import { moderationsLimiter } from "../shared";

const moderations = new Hono<{ Variables: AppVariables }>();

moderations.post("/moderations", requireApiKey, moderationsLimiter, async (c) =>
  proxy(env.OPENAI_MODERATION_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_MODERATION_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await c.req.json()),
  }),
);

export default moderations;
