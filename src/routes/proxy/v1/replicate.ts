import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  allowedReplicateModels,
  replicateModelCosts,
} from "../../../config/replicate-models";
import { env } from "../../../env";
import { isFeatureEnabled } from "../../../lib/posthog";
import { requireApiKey } from "../../../middleware/auth";
import { checkSpendingLimit } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import { logRequest, standardLimiter } from "../shared";

const replicate = new Hono<{ Variables: AppVariables }>();

// --- Middleware ---

const checkReplicateFeature = createMiddleware<{ Variables: AppVariables }>(
  async (c, next) => {
    const user = c.get("user");
    const enabled = await isFeatureEnabled(user, "enable_replicate");
    if (!enabled) {
      throw new HTTPException(403, {
        message: "Replicate access is not enabled for your account",
      });
    }
    await next();
  },
);

replicate.use("*", requireApiKey, standardLimiter, checkReplicateFeature);

const versionModelCache = new Map<string, { owner: string; model: string }>();

async function fetchModelFromVersion(
  versionHash: string,
): Promise<{ owner: string; model: string }> {
  const cached = versionModelCache.get(versionHash);
  if (cached) return cached;

  // Replicate doesn't have a global lookup for versions :(
  for (const modelId of allowedReplicateModels) {
    const [owner, model] = modelId.split("/");
    const res = await fetch(
      `https://api.replicate.com/v1/models/${owner}/${model}/versions/${versionHash}`,
      { headers: { Authorization: `Bearer ${env.REPLICATE_API_KEY}` } },
    );

    if (res.ok) {
      const modelInfo = { owner, model };
      versionModelCache.set(versionHash, modelInfo);
      return modelInfo;
    }
  }

  throw new HTTPException(400, {
    message: `Could not find allowed model for version ${versionHash}`,
  });
}

replicate.post(
  "/replicate/models/:owner/:model/predictions",
  checkSpendingLimit,
  async (c) => {
    const { owner, model } = c.req.param();
    const fullModelId = `${owner}/${model}`;

    if (!allowedReplicateModels.includes(fullModelId)) {
      throw new HTTPException(400, {
        message: `Invalid model. Allowed models: ${allowedReplicateModels.join(", ")}`,
      });
    }

    const start = Date.now();
    const body = await c.req.json();

    const res = await fetch(
      `https://api.replicate.com/v1/models/${fullModelId}/predictions`,
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
    const cost = replicateModelCosts.get(fullModelId) || 0;

    await logRequest(
      c,
      { model: fullModelId, stream: false },
      data,
      { prompt: 0, completion: 0, total: 0, cost },
      Date.now() - start,
    );

    return c.json(data, res.status as ContentfulStatusCode);
  },
);

replicate.post("/replicate/predictions", checkSpendingLimit, async (c) => {
  const body = await c.req.json();
  const version = body.version as string | undefined;

  if (!version || !/^[a-f0-9]{64}$/.test(version)) {
    throw new HTTPException(400, {
      message: "Invalid or missing version hash",
    });
  }

  const { owner, model } = await fetchModelFromVersion(version);
  const baseModelId = `${owner}/${model}`;

  if (!allowedReplicateModels.includes(baseModelId)) {
    throw new HTTPException(400, { message: "Model not allowed" });
  }

  const start = Date.now();

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
  const cost = replicateModelCosts.get(baseModelId) || 0;

  await logRequest(
    c,
    { model: baseModelId, stream: false },
    data,
    { prompt: 0, completion: 0, total: 0, cost },
    Date.now() - start,
  );

  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.get("/replicate/models/:owner/:model", async (c) => {
  const { owner, model } = c.req.param();
  const fullModelId = `${owner}/${model}`;

  if (!allowedReplicateModels.includes(fullModelId)) {
    throw new HTTPException(400, {
      message: `Invalid model. Allowed models: ${allowedReplicateModels.join(", ")}`,
    });
  }

  const res = await fetch(
    `https://api.replicate.com/v1/models/${owner}/${model}`,
    {
      headers: { Authorization: `Bearer ${env.REPLICATE_API_KEY}` },
    },
  );

  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.get("/replicate/predictions/:id", async (c) => {
  const { id } = c.req.param();

  if (!/^[a-z0-9]+$/.test(id)) {
    throw new HTTPException(400, { message: "Invalid prediction ID" });
  }

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Bearer ${env.REPLICATE_API_KEY}` },
  });

  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

export default replicate;
