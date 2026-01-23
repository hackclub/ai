import * as Sentry from "@sentry/bun";
import { eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { proxy as honoProxy } from "hono/proxy";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { rateLimiter } from "hono-rate-limiter";

import { db } from "../db";
import { requestLogs } from "../db/schema";
import {
  allowedEmbeddingModels,
  allowedImageModels,
  allowedLanguageModels,
  env,
} from "../env";
import {
  fetchEmbeddingModels,
  fetchImageModels,
  fetchLanguageModels,
} from "../lib/models";
import { blockAICodingAgents, requireApiKey } from "../middleware/auth";
import { checkSpendingLimit } from "../middleware/limits";
import type { AppVariables } from "../types";

type Ctx = Context<{ Variables: AppVariables }>;
type ProxyReq = {
  model: string;
  stream?: boolean;
  user?: string;
  usage?: { include: boolean };
};

const MODEL_POOL = [
  ...allowedLanguageModels,
  ...allowedImageModels,
  ...allowedEmbeddingModels,
];

const limiter = (limit: number) =>
  rateLimiter({
    limit,
    windowMs: 30 * 60 * 1000,
    keyGenerator: (c: Ctx) => c.get("user")?.id || c.get("ip"),
  });

const standardLimiter = limiter(450);
const moderationsLimiter = limiter(300);

const SIZE_RATIOS: Record<string, string> = {
  "1024x1024": "1:1",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
  "512x512": "1:1",
  "256x256": "1:1",
};

const resolveUsage = (data: unknown) => {
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

const apiHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
  "HTTP-Referer": `${env.BASE_URL}/global`,
  "X-Title": "Hack Club AI",
});

const resolveModel = (model: string, pool: string[]) =>
  pool.includes(model)
    ? model
    : pool.find((m) => m.split("/")[1] === model) || pool[0];

const proxy = new Hono<{ Variables: AppVariables }>();

const logRequest = (
  c: Ctx,
  body: ProxyReq,
  resBody: unknown,
  usage: ReturnType<typeof resolveUsage>,
  ms: number,
) =>
  Sentry.startSpan({ name: "db.log" }, () =>
    db
      .insert(requestLogs)
      .values({
        apiKeyId: c.get("apiKey").id,
        userId: c.get("user").id,
        slackId: c.get("user").slackId,
        model: body.model,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        cost: String(usage.cost),
        request: body,
        response: resBody,
        duration: ms,
        headers: c.req.raw.headers,
        ip: c.get("ip"),
        timestamp: new Date(),
      })
      .catch((e) => console.error("Logging failed:", e)),
  );

async function handleProxy(c: Ctx, endpoint: string) {
  const start = Date.now();
  const body = (await c.req.json()) as ProxyReq;
  body.model = resolveModel(body.model, MODEL_POOL);
  body.user = `user_${c.get("user").id}`;
  if (endpoint !== "embeddings") body.usage = { include: true };

  const res = await fetch(`${env.OPENAI_API_URL}/v1/${endpoint}`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });

  if (!body.stream) {
    const data = await res.json();
    await logRequest(c, body, data, resolveUsage(data), Date.now() - start);
    return c.json(data, res.status as ContentfulStatusCode);
  }

  return stream(c, async (s) => {
    const reader = res.body?.getReader(),
      decoder = new TextDecoder(),
      chunks: string[] = [];
    let usage = { prompt: 0, completion: 0, total: 0, cost: 0 };
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = decoder.decode(value, { stream: true });
      chunks.push(part);
      await s.write(value);
      for (const line of part
        .split("\n")
        .filter((l) => l.startsWith("data: "))) {
        const raw = line.slice(6).trim();
        if (raw !== "[DONE]")
          try {
            usage = resolveUsage(JSON.parse(raw));
          } catch {}
      }
    }
    await logRequest(
      c,
      body,
      { stream: true, content: chunks.join("\n") },
      usage,
      Date.now() - start,
    );
  });
}

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

for (const ep of ["chat/completions", "responses", "embeddings"])
  proxy.post(`/${ep}`, standardLimiter, checkSpendingLimit, (c) =>
    handleProxy(c, ep),
  );

proxy.post("/moderations", moderationsLimiter, async (c) =>
  honoProxy(env.OPENAI_MODERATION_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_MODERATION_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await c.req.json()),
  }),
);

proxy.post(
  "/images/generations",
  standardLimiter,
  checkSpendingLimit,
  async (c) => {
    const start = Date.now();
    const body = (await c.req.json()) as {
      prompt: string;
      model?: string;
      size?: string;
      response_format?: "url" | "b64_json";
    };
    const model = resolveModel(
      body.model || allowedImageModels[0],
      allowedImageModels,
    );

    const res = await fetch(`${env.OPENAI_API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: body.prompt }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: SIZE_RATIOS[body.size || ""] || "1:1" },
        user: `user_${c.get("user").id}`,
        usage: { include: true },
      }),
    });

    const data = (await res.json()) as {
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      usage?: Record<string, number>;
    };
    if (!res.ok) return c.json(data, res.status as ContentfulStatusCode);

    const images = (data.choices || []).flatMap((ch) =>
      (ch.message?.images || []).flatMap((img) => {
        const url = img.image_url?.url;
        return url?.startsWith("data:")
          ? [body.response_format === "url" ? { url } : { b64_json: url.split(",")[1] }]
          : [];
      }),
    );

    await logRequest(
      c,
      { model, stream: false },
      data,
      resolveUsage(data),
      Date.now() - start,
    );
    return c.json({ created: Math.floor(Date.now() / 1000), data: images });
  },
);

export default proxy;
