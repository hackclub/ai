import * as Sentry from "@sentry/bun";
import { eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { proxy as honoProxy } from "hono/proxy";
import { stream } from "hono/streaming";
import { rateLimiter } from "hono-rate-limiter";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { db } from "../db";
import { requestLogs } from "../db/schema";
import {
  env,
  allowedEmbeddingModels,
  allowedImageModels,
  allowedLanguageModels,
} from "../env";
import {
  fetchEmbeddingModels,
  fetchImageModels,
  fetchLanguageModels,
} from "../lib/models";
import { blockAICodingAgents, requireApiKey } from "../middleware/auth";
import { checkSpendingLimit } from "../middleware/limits";
import type { AppVariables } from "../types";

// --- Types ---
type Usage = {
  prompt: number;
  completion: number;
  total: number;
  cost: number;
};
type ProxyReq = {
  model: string;
  stream?: boolean;
  user?: string;
  usage?: { include: boolean };
};

interface ProviderResponse {
  usage?: {
    prompt_tokens?: number;
    input_tokens?: number;
    completion_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  response?: { usage?: ProviderResponse["usage"] };
}

const MODEL_POOL = [
  ...allowedLanguageModels,
  ...allowedImageModels,
  ...allowedEmbeddingModels,
];

// --- Shared Rate Limiters ---
const createLimiter = (limit: number) =>
  rateLimiter({
    limit,
    windowMs: 30 * 60 * 1000,
    keyGenerator: (c: Context<{ Variables: AppVariables }>) =>
      c.get("user")?.id || c.get("ip"),
  });

const standardLimiter = createLimiter(450);
const moderationsLimiter = createLimiter(300);

// --- Helpers ---
const resolveUsage = (data: unknown): Usage => {
  const d = data as ProviderResponse;
  const u = d?.usage || d?.response?.usage || {};
  return {
    prompt: u.prompt_tokens || u.input_tokens || 0,
    completion: u.completion_tokens || u.output_tokens || 0,
    total: u.total_tokens || 0,
    cost: u.cost || 0,
  };
};

const proxy = new Hono<{ Variables: AppVariables }>();

async function logRequest(
  c: Context<{ Variables: AppVariables }>,
  body: ProxyReq,
  resBody: unknown,
  usage: Usage,
  ms: number,
) {
  const user = c.get("user");
  return Sentry.startSpan({ name: "db.log" }, () =>
    db
      .insert(requestLogs)
      .values({
        apiKeyId: c.get("apiKey").id,
        userId: user.id,
        slackId: user.slackId,
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
}

// --- Proxy Handler ---
async function handleProxy(
  c: Context<{ Variables: AppVariables }>,
  endpoint: string,
) {
  const start = Date.now();
  const body = (await c.req.json()) as ProxyReq;

  if (!MODEL_POOL.includes(body.model)) {
    body.model =
      MODEL_POOL.find((m) => m.split("/")[1] === body.model) || MODEL_POOL[0];
  }

  body.user = `user_${c.get("user").id}`;
  if (endpoint !== "embeddings") body.usage = { include: true };

  const res = await fetch(`${env.OPENAI_API_URL}/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "HTTP-Referer": `${env.BASE_URL}/global`,
      "X-Title": "Hack Club AI",
    },
    body: JSON.stringify(body),
  });

  if (!body.stream) {
    const data = await res.json();
    await logRequest(c, body, data, resolveUsage(data), Date.now() - start);
    return c.json(data, res.status as ContentfulStatusCode);
  }

  return stream(c, async (s) => {
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let usage: Usage = { prompt: 0, completion: 0, total: 0, cost: 0 };

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = decoder.decode(value, { stream: true });
      chunks.push(part);
      await s.write(value);

      part
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .forEach((line) => {
          const raw = line.replace("data: ", "").trim();
          if (raw !== "[DONE]") {
            try {
              usage = resolveUsage(JSON.parse(raw));
            } catch {}
          }
        });
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

proxy.use("*", bodyLimit({ maxSize: 20 * 1024 * 1024 }));
proxy.use("*", blockAICodingAgents);
proxy.use("*", async (c, next) => {
  const ip =
    c.req.header("CF-Connecting-IP") ||
    (env.NODE_ENV === "development" ? "127.0.0.1" : "0.0.0.0");
  c.set("ip", ip);
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
  const stats = await db
    .select({
      totalRequests: sql<number>`COUNT(*)::int`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
    })
    .from(requestLogs)
    .where(eq(requestLogs.userId, c.get("user").id));
  return c.json(
    stats[0] || {
      totalRequests: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    },
  );
});

proxy.post("/chat/completions", standardLimiter, checkSpendingLimit, (c) =>
  handleProxy(c, "chat/completions"),
);
proxy.post("/responses", standardLimiter, checkSpendingLimit, (c) =>
  handleProxy(c, "responses"),
);
proxy.post("/embeddings", standardLimiter, checkSpendingLimit, (c) =>
  handleProxy(c, "embeddings"),
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

export default proxy;
