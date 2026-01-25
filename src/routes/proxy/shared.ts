import * as Sentry from "@sentry/bun";
import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";

import { db } from "../../db";
import { requestLogs } from "../../db/schema";
import {
  allowedEmbeddingModels,
  allowedImageModels,
  allowedLanguageModels,
  env,
} from "../../env";
import { openRouterHeaders } from "../../lib/models";
import { captureEvent } from "../../lib/posthog";
import type { AppVariables } from "../../types";

export type Ctx = Context<{ Variables: AppVariables }>;

const SAFE_HEADERS = [
  "user-agent",
  "content-type",
  "accept",
  "accept-language",
  "origin",
  "referer",
];

const sanitizeHeaders = (headers: Headers): Record<string, string> => {
  const safe: Record<string, string> = {};
  for (const key of SAFE_HEADERS) {
    const value = headers.get(key);
    if (value) safe[key] = value;
  }
  return safe;
};

export type ProxyReq = {
  model: string;
  stream?: boolean;
  user?: string;
  usage?: { include: boolean };
};

export const MODEL_POOL = [
  ...allowedLanguageModels,
  ...allowedImageModels,
  ...allowedEmbeddingModels,
];

export const SIZE_RATIOS: Record<string, string> = {
  "1024x1024": "1:1",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
  "512x512": "1:1",
  "256x256": "1:1",
};

const limiter = (limit: number) =>
  rateLimiter({
    limit,
    windowMs: 30 * 60 * 1000,
    keyGenerator: (c: Ctx) => c.get("user")?.id || c.get("ip"),
  });

export const standardLimiter = limiter(450);
export const moderationsLimiter = limiter(300);

export const resolveUsage = (data: unknown) => {
  const u =
    (
      data as {
        usage?: Record<string, number>;
        response?: { usage?: Record<string, number> };
      }
    )?.usage ||
    (data as { response?: { usage?: Record<string, number> } })?.response
      ?.usage ||
    {};
  return {
    prompt: u.prompt_tokens || u.input_tokens || 0,
    completion: u.completion_tokens || u.output_tokens || 0,
    total: u.total_tokens || 0,
    cost: u.cost || 0,
  };
};

export const apiHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
  ...openRouterHeaders,
});

export const resolveModel = (model: string, pool: string[]) =>
  pool.includes(model) ? model : pool[0];

export const logRequest = (
  c: Ctx,
  body: ProxyReq | Record<string, unknown>,
  resBody: unknown,
  usage: ReturnType<typeof resolveUsage>,
  ms: number,
) => {
  const user = c.get("user");
  const model = (body as ProxyReq).model || "unknown";

  Sentry.startSpan({ name: "db.log" }, () =>
    db
      .insert(requestLogs)
      .values({
        apiKeyId: c.get("apiKey").id,
        userId: user.id,
        slackId: user.slackId,
        model,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        cost: String(usage.cost),
        request: body,
        response: resBody,
        duration: ms,
        headers: sanitizeHeaders(c.req.raw.headers),
        ip: c.get("ip"),
        timestamp: new Date(),
      })
      .catch((e) => console.error("Logging failed:", e)),
  );

  captureEvent(user, "api_request", {
    model,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    totalTokens: usage.total,
    cost: usage.cost,
    duration: ms,
  });
};
