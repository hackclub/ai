import fs from "node:fs";
import path from "node:path";
import { type Context, Hono } from "hono";
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

const mapPath = path.join(
  process.cwd(),
  "src/config/allowed-replicate-model-versions.json",
);
const raw = fs.readFileSync(mapPath, "utf-8");
const allowedVersionsMap: Record<string, string> = JSON.parse(raw);

const replicate = new Hono<{ Variables: AppVariables }>();

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

const getReplicateHeaders = (c: Context) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.REPLICATE_API_KEY}`,
    "User-Agent": "ReplicateProxy/1.0",
  };
  const prefer = c.req.header("Prefer");
  if (prefer) headers.Prefer = prefer;
  if (c.req.header("Content-Type") === "application/json") {
    headers["Content-Type"] = "application/json";
  }
  return headers;
};

const validateModelAccess = (owner: string, name: string) => {
  const fullId = `${owner}/${name}`;
  if (!allowedReplicateModels.includes(fullId)) {
    throw new HTTPException(403, {
      message: `Model ${fullId} is not in the allowed list.`,
    });
  }
  return fullId;
};

replicate.post("/replicate/files", async (c: Context) => {
  const body = await c.req.parseBody();
  const formData = new FormData();

  if (body.content && body.content instanceof File) {
    formData.append("content", body.content);
  } else {
    throw new HTTPException(400, { message: "File content is required" });
  }

  if (body.metadata) {
    formData.append("metadata", body.metadata as string);
  }

  const res = await fetch("https://api.replicate.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.REPLICATE_API_KEY}`,
    },
    body: formData,
  });

  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.get("/replicate/files/:id", async (c: Context) => {
  const { id } = c.req.param();
  const res = await fetch(`https://api.replicate.com/v1/files/${id}`, {
    headers: getReplicateHeaders(c),
  });
  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.delete("/replicate/files/:id", async (c: Context) => {
  const { id } = c.req.param();
  const res = await fetch(`https://api.replicate.com/v1/files/${id}`, {
    method: "DELETE",
    headers: getReplicateHeaders(c),
  });
  return c.body(null, res.status as ContentfulStatusCode);
});

replicate.post(
  "/replicate/deployments/:owner/:name/predictions",
  checkSpendingLimit,
  async (c: Context) => {
    const { owner, name } = c.req.param();
    const fullId = validateModelAccess(owner, name);
    const start = Date.now();
    const body = await c.req.json();

    const res = await fetch(
      `https://api.replicate.com/v1/deployments/${owner}/${name}/predictions`,
      {
        method: "POST",
        headers: getReplicateHeaders(c),
        body: JSON.stringify(body),
      },
    );

    const data = await res.json();

    if (res.ok) {
      const cost = replicateModelCosts.get(fullId) || 0;
      await logRequest(
        c,
        { model: fullId, stream: false },
        data,
        { prompt: 0, completion: 0, total: 0, cost },
        Date.now() - start,
      );
    }

    return c.json(data, res.status as ContentfulStatusCode);
  },
);

replicate.get("/replicate/deployments/:owner/:name", async (c: Context) => {
  const { owner, name } = c.req.param();
  validateModelAccess(owner, name);

  const res = await fetch(
    `https://api.replicate.com/v1/deployments/${owner}/${name}`,
    { headers: getReplicateHeaders(c) },
  );
  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.get("/replicate/deployments", async (c: Context) => {
  const url = new URL("https://api.replicate.com/v1/deployments");
  const cursor = c.req.query("cursor");
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url.toString(), {
    headers: getReplicateHeaders(c),
  });
  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.post(
  "/replicate/models/:owner/:model/predictions",
  checkSpendingLimit,
  async (c: Context) => {
    const { owner, model } = c.req.param();
    const fullModelId = validateModelAccess(owner, model);

    const start = Date.now();
    const body = await c.req.json();

    const res = await fetch(
      `https://api.replicate.com/v1/models/${fullModelId}/predictions`,
      {
        method: "POST",
        headers: getReplicateHeaders(c),
        body: JSON.stringify(body),
      },
    );

    const data = await res.json();

    if (res.ok) {
      const cost = replicateModelCosts.get(fullModelId) || 0;
      await logRequest(
        c,
        { model: fullModelId, stream: false },
        data,
        { prompt: 0, completion: 0, total: 0, cost },
        Date.now() - start,
      );
    }

    return c.json(data, res.status as ContentfulStatusCode);
  },
);

replicate.post(
  "/replicate/predictions",
  checkSpendingLimit,
  async (c: Context) => {
    const body = await c.req.json();
    const version = body.version as string | undefined;

    let modelString = body.model as string | undefined;

    if (!modelString && version) {
      modelString = allowedVersionsMap[version];
    }

    if (!modelString) {
      throw new HTTPException(400, {
        message:
          "Could not validate model access. Please provide the 'model' field (owner/name) in the body, or ensure the 'version' is recognized.",
      });
    }

    const [owner, name] = modelString.split("/");
    if (!owner || !name) {
      throw new HTTPException(400, { message: "Invalid model format." });
    }

    const fullModelId = validateModelAccess(owner, name);
    const start = Date.now();

    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: getReplicateHeaders(c),
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (res.ok) {
      const cost = replicateModelCosts.get(fullModelId) || 0;
      await logRequest(
        c,
        { model: fullModelId, stream: false },
        data,
        { prompt: 0, completion: 0, total: 0, cost },
        Date.now() - start,
      );
    }

    return c.json(data, res.status as ContentfulStatusCode);
  },
);

replicate.get("/replicate/predictions/:id", async (c: Context) => {
  const { id } = c.req.param();
  if (!/^[a-z0-9]+$/.test(id)) {
    throw new HTTPException(400, { message: "Invalid prediction ID" });
  }

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: getReplicateHeaders(c),
  });

  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.post("/replicate/predictions/:id/cancel", async (c: Context) => {
  const { id } = c.req.param();
  if (!/^[a-z0-9]+$/.test(id)) {
    throw new HTTPException(400, { message: "Invalid prediction ID" });
  }

  const res = await fetch(
    `https://api.replicate.com/v1/predictions/${id}/cancel`,
    {
      method: "POST",
      headers: getReplicateHeaders(c),
    },
  );

  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.get("/replicate/predictions", async (c: Context) => {
  const url = new URL("https://api.replicate.com/v1/predictions");
  const cursor = c.req.query("cursor");
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url.toString(), {
    headers: getReplicateHeaders(c),
  });

  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.get("/replicate/models/:owner/:model", async (c: Context) => {
  const { owner, model } = c.req.param();
  validateModelAccess(owner, model);

  const res = await fetch(
    `https://api.replicate.com/v1/models/${owner}/${model}`,
    { headers: getReplicateHeaders(c) },
  );

  const data = await res.json();
  return c.json(data, res.status as ContentfulStatusCode);
});

replicate.get(
  "/replicate/models/:owner/:model/versions",
  async (c: Context) => {
    const { owner, model } = c.req.param();
    validateModelAccess(owner, model);

    const res = await fetch(
      `https://api.replicate.com/v1/models/${owner}/${model}/versions`,
      { headers: getReplicateHeaders(c) },
    );

    const data = await res.json();
    return c.json(data, res.status as ContentfulStatusCode);
  },
);

replicate.get(
  "/replicate/models/:owner/:model/versions/:id",
  async (c: Context) => {
    const { owner, model, id } = c.req.param();
    validateModelAccess(owner, model);

    const res = await fetch(
      `https://api.replicate.com/v1/models/${owner}/${model}/versions/${id}`,
      { headers: getReplicateHeaders(c) },
    );

    const data = await res.json();
    return c.json(data, res.status as ContentfulStatusCode);
  },
);

export default replicate;
