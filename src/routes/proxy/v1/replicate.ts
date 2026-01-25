import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { replicateModelCosts } from "../../../config/replicate-models";
import { env } from "../../../env";
import { isFeatureEnabled } from "../../../lib/posthog";
import { checkSpendingLimit } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import { logRequest, standardLimiter } from "../shared";

const replicate = new Hono<{ Variables: AppVariables }>();

replicate.post(
  "/replicate/models/:owner/:model/predictions",
  standardLimiter,
  checkSpendingLimit,
  async (c) => {
    const user = c.get("user");
    const enabled = await isFeatureEnabled(user, "enable_replicate");
    if (!enabled) {
      throw new HTTPException(403, {
        message: "Replicate access is not enabled for your account",
      });
    }

    const { owner, model } = c.req.param();
    const modelId = `${owner}/${model}`;

    const start = Date.now();
    const body = await c.req.json();

    const res = await fetch(
      `https://api.replicate.com/v1/models/${modelId}/predictions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.REPLICATE_API_KEY}`,
          "Content-Type": "application/json",
          Prefer: "wait=60",
        },
        body: JSON.stringify(body),
      },
    );

    const data = await res.json();
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
