import { Hono } from "hono";
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

// Cache: version hash -> { owner, model }
const versionModelCache = new Map<string, { owner: string; model: string }>();

async function fetchModelFromVersion(
  versionHash: string,
): Promise<{ owner: string; model: string }> {
  // Check cache first
  const cached = versionModelCache.get(versionHash);
  if (cached) {
    return cached;
  }

  const res = await fetch(
    `https://api.replicate.com/v1/versions/${versionHash}`,
    {
      headers: { Authorization: `Bearer ${env.REPLICATE_API_KEY}` },
    },
  );

  if (!res.ok) {
    throw new HTTPException(400, {
      message: `Could not fetch model for version ${versionHash}`,
    });
  }

  const versionData = (await res.json()) as {
    model_id?: string;
  };

  if (!versionData.model_id) {
    throw new HTTPException(400, {
      message: "Could not determine model from version",
    });
  }

  const [owner, model] = versionData.model_id.split("/");
  const modelInfo = { owner, model };

  versionModelCache.set(versionHash, modelInfo);

  return modelInfo;
}

replicate.post(
  "/replicate/models/:owner/:model/predictions",
  requireApiKey,
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
    const fullModelId = `${owner}/${model}`;

    if (!/^[a-z0-9_-]+$/.test(owner) || !/^[a-z0-9_-]+$/.test(model)) {
      throw new HTTPException(400, { message: "Invalid model identifier" });
    }

    if (!allowedReplicateModels.includes(fullModelId)) {
      throw new HTTPException(400, {
        message: `Invalid model. Allowed models: ${allowedReplicateModels.join(", ")}`,
      });
    }

    const start = Date.now();
    const body = await c.req.json();

    const apiPath = `https://api.replicate.com/v1/models/${fullModelId}/predictions`;

    const res = await fetch(apiPath, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify(body),
    });

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

replicate.post(
  "/replicate/predictions",
  requireApiKey,
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

    const body = await c.req.json();
    const version = body.version as string | undefined;

    if (!version) {
      throw new HTTPException(400, {
        message: "version is required in request body",
      });
    }

    if (!/^[a-f0-9]{64}$/.test(version)) {
      throw new HTTPException(400, { message: "Invalid version hash" });
    }

    // Fetch model info from version
    const { owner, model } = await fetchModelFromVersion(version);
    const baseModelId = `${owner}/${model}`;

    // Validate model is allowed
    if (!allowedReplicateModels.includes(baseModelId)) {
      throw new HTTPException(400, {
        message: `Invalid model. Allowed models: ${allowedReplicateModels.join(", ")}`,
      });
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
  },
);

export default replicate;
