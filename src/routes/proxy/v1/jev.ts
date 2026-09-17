import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { env } from "../../../env";
import { isFeatureEnabled } from "../../../lib/posthog";
import { requireApiKey } from "../../../middleware/auth";
import { checkSpendingLimit } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import { type Ctx, logRequest, standardLimiter } from "../shared";

// Jev (TypeSafe's System One model) - https://docs.typesafe.ai/api
const TYPESAFE_API_URL = "https://api.typesafe.ai";

// Charged per input token only; output tokens are free.
// https://docs.typesafe.ai/models
const JEV_INPUT_PRICE_PER_TOKEN = 0.042 / 1_000_000;

type JevResponse = {
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

const jev = new Hono<{ Variables: AppVariables }>();

const checkJevFeature = async (c: Ctx, next: () => Promise<void>) => {
  const user = c.get("user");
  const enabled = await isFeatureEnabled(user, "enable_jev");
  if (!enabled) {
    throw new HTTPException(403, {
      message:
        "Jev access is currently in closed beta. Contact support for access.",
    });
  }
  await next();
};

jev.use(
  "/jev/*",
  requireApiKey,
  standardLimiter,
  checkJevFeature,
  checkSpendingLimit,
);

const jevHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
});

const resolveJevUsage = (data: unknown) => {
  const usage = (data as JevResponse)?.usage;
  const prompt =
    typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const completion =
    typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  return {
    prompt,
    completion,
    total: prompt + completion,
    cost: prompt * JEV_INPUT_PRICE_PER_TOKEN,
  };
};

const labelForModel = (model: unknown) =>
  `jev/${typeof model === "string" && model ? model : "jev-latest"}`;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

async function handleSystemOne(c: Ctx) {
  const start = Date.now();
  let body: Record<string, unknown> = {};

  try {
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }

    if (typeof body.model !== "string" || !body.model) {
      body.model = "jev-latest";
    }

    const res = await fetch(`${TYPESAFE_API_URL}/v1/systemone`, {
      method: "POST",
      headers: jevHeaders(),
      body: JSON.stringify(body),
    });

    const data = parseJson(await res.text());
    // Log under the versioned id that actually answered (e.g. jev/jev-1.13.0)
    // so aliases like jev-latest can be traced to a concrete release.
    const model = labelForModel((data as JevResponse)?.model ?? body.model);

    await logRequest(
      c,
      { ...body, model },
      data,
      res.ok
        ? resolveJevUsage(data)
        : { prompt: 0, completion: 0, total: 0, cost: 0 },
      Date.now() - start,
    );

    return c.json(data as object, res.status as ContentfulStatusCode);
  } catch (error) {
    if (error instanceof HTTPException) throw error;

    console.error("Jev proxy error:", error);

    await logRequest(
      c,
      { ...body, model: labelForModel(body.model) },
      { error: error instanceof Error ? error.message : "Unknown error" },
      { prompt: 0, completion: 0, total: 0, cost: 0 },
      Date.now() - start,
    );

    throw new HTTPException(500, { message: "Internal server error" });
  }
}

async function handleModels(c: Ctx) {
  try {
    const res = await fetch(`${TYPESAFE_API_URL}/v1/models`, {
      headers: jevHeaders(),
    });
    const data = parseJson(await res.text());
    return c.json(data as object, res.status as ContentfulStatusCode);
  } catch (error) {
    console.error("Jev models proxy error:", error);
    throw new HTTPException(500, { message: "Internal server error" });
  }
}

// `/jev/v1/*` mirrors TypeSafe's own paths so the official SDKs work with
// baseURL set to https://ai.hackclub.com/proxy/v1/jev. `/jev/*` is the
// shorter form for hand-written requests.
for (const prefix of ["/jev", "/jev/v1"]) {
  jev.post(`${prefix}/systemone`, handleSystemOne);
  jev.get(`${prefix}/models`, handleModels);
}

export default jev;
