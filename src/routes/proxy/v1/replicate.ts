import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { replicateModelCosts } from "../../../config/replicate-models";
import { env } from "../../../env";
import { checkSpendingLimit } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import { logRequest, standardLimiter } from "../shared";

const replicate = new Hono<{ Variables: AppVariables }>();

replicate.post(
  "/predictions",
  standardLimiter,
  checkSpendingLimit,
  async (c) => {
    const start = Date.now();
    const body = await c.req.json();

    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    const modelId = body.model;
    const cost = replicateModelCosts.get(modelId) || 0;

    await logRequest(
      c,
      { model: modelId, stream: false },
      data,
      { prompt: 0, completion: 0, total: 0, cost },
      Date.now() - start,
    );

    return c.json(data, res.status as ContentfulStatusCode);
  },
);

export default replicate;
