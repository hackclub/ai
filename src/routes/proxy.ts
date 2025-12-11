import * as Sentry from "@sentry/bun";
import { eq, sql } from "drizzle-orm";
import { type Context, Hono, type TypedResponse } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { HTTPException } from "hono/http-exception";
import { proxy as honoProxy } from "hono/proxy";
import { stream } from "hono/streaming";
import { timeout } from "hono/timeout";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { rateLimiter } from "hono-rate-limiter";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { allowedEmbeddingModels, allowedLanguageModels, env } from "../env";
import { fetchEmbeddingModels, fetchLanguageModels } from "../lib/models";
import { blockAICodingAgents, requireApiKey } from "../middleware/auth";
import type { AppVariables } from "../types";

type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type CompletionConfig = {
  endpoint: string;
  extractUsage: (data: Record<string, unknown>) => TokenUsage;
  extractStreamUsage: (parsed: Record<string, unknown>) => TokenUsage | null;
};

const chatCompletionsConfig: CompletionConfig = {
  endpoint: "chat/completions",
  extractUsage: (data) => ({
    promptTokens: (data.usage as Record<string, number>)?.prompt_tokens || 0,
    completionTokens:
      (data.usage as Record<string, number>)?.completion_tokens || 0,
    totalTokens: (data.usage as Record<string, number>)?.total_tokens || 0,
  }),
  extractStreamUsage: (parsed) => {
    if (parsed.usage) {
      const usage = parsed.usage as Record<string, number>;
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      };
    }
    return null;
  },
};

const responsesConfig: CompletionConfig = {
  endpoint: "responses",
  extractUsage: (data) => ({
    promptTokens: (data.usage as Record<string, number>)?.input_tokens || 0,
    completionTokens:
      (data.usage as Record<string, number>)?.output_tokens || 0,
    totalTokens: (data.usage as Record<string, number>)?.total_tokens || 0,
  }),
  extractStreamUsage: (parsed) => {
    if (parsed.type === "response.done" && parsed.response) {
      const usage = (parsed.response as Record<string, unknown>)
        .usage as Record<string, number>;
      if (usage) {
        return {
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        };
      }
    }
    return null;
  },
};

const proxy = new Hono<{ Variables: AppVariables }>();

proxy.use(
  "*",
  bodyLimit({
    maxSize: 20 * 1024 * 1024,
    onError: () => {
      throw new HTTPException(413, { message: "Request too large" });
    },
  }),
  timeout(180000),
  (c, next) => {
    const cfIp = c.req.header("CF-Connecting-IP");
    if (!cfIp && env.NODE_ENV !== "development") {
      throw new HTTPException(400, {
        message:
          "Missing CF-Connecting-IP. This is a bug. Please contact support.",
      });
    }
    c.set("ip", cfIp || "127.0.0.1"); // dev check above!
    return next();
  },
);

const limiterOpts = {
  limit: 150,
  windowMs: 30 * 60 * 1000, // 30 minutes
  standardHeaders: "draft-6", // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
  keyGenerator: (c: Context<{ Variables: AppVariables }>) =>
    c.get("user")?.id || c.get("ip"),
} as const;
const standardLimiter = rateLimiter(limiterOpts);
const moderationsLimiter = rateLimiter({
  ...limiterOpts,
  limit: 300,
});

const openRouterHeaders = {
  "HTTP-Referer": `${env.BASE_URL}/global?utm_source=openrouter`,
  "X-Title": "Hack Club AI",
};

proxy.use("*", blockAICodingAgents);

proxy.use((c, next) => {
  if (c.req.path.endsWith("/models")) {
    return next();
  }
  return requireApiKey(c, next);
});

proxy.use("/models", etag());
proxy.use("/embeddings/models", etag());

function getRequestHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

async function logRequest(
  c: Context<{ Variables: AppVariables }>,
  data: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    request: unknown;
    response: unknown;
    duration: number;
  },
) {
  const apiKey = c.get("apiKey");
  const user = c.get("user");

  await db
    .insert(requestLogs)
    .values({
      apiKeyId: apiKey.id,
      userId: user.id,
      slackId: user.slackId,
      model: data.model,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      totalTokens: data.totalTokens,
      request: data.request,
      response: data.response,
      headers: getRequestHeaders(c),
      ip: c.get("ip"),
      timestamp: new Date(),
      duration: data.duration,
    })
    .catch((err) => console.error("Logging error:", err));
}

async function handleCompletionRequest(
  c: Context<{ Variables: AppVariables }>,
  config: CompletionConfig,
): Promise<TypedResponse<Record<string, unknown>, ContentfulStatusCode>> {
  const user = c.get("user");
  const startTime = Date.now();

  try {
    const requestBody = (await c.req.json()) as {
      model: string;
      stream?: boolean;
      user?: string;
    };

    const allowedSet = new Set(allowedLanguageModels);
    if (!allowedSet.has(requestBody.model)) {
      requestBody.model = allowedLanguageModels[0];
    }

    requestBody.user = `user_${user.id}`;

    const isStreaming = requestBody.stream === true;

    const response = await fetch(
      `${env.OPENAI_API_URL}/v1/${config.endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          ...openRouterHeaders,
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (!isStreaming) {
      const responseData = (await response.json()) as Record<string, unknown>;
      const duration = Date.now() - startTime;
      const usage = config.extractUsage(responseData);

      Sentry.startSpan({ name: "db.insert.requestLog" }, async () => {
        await logRequest(c, {
          model: requestBody.model,
          ...usage,
          request: requestBody,
          response: responseData,
          duration,
        });
      });

      return c.json(responseData, response.status as ContentfulStatusCode);
    }

    return stream(c, async (stream) => {
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let usage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);

          await stream.write(value);

          const lines = chunk
            .split("\n")
            .filter((line) => line.trim().startsWith("data: "));
          for (const line of lines) {
            const data = line.replace(/^data: /, "").trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const extractedUsage = config.extractStreamUsage(parsed);
              if (extractedUsage) {
                usage = extractedUsage;
              }
            } catch {}
          }
        }
      } finally {
        const duration = Date.now() - startTime;

        Sentry.startSpan({ name: "db.insert.requestLogStream" }, async () => {
          await logRequest(c, {
            model: requestBody.model,
            ...usage,
            request: requestBody,
            response: { stream: true, chunks: chunks.join("") },
            duration,
          });
        });
      }
    }) as unknown as TypedResponse<Record<string, unknown>, ContentfulStatusCode>;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`${config.endpoint} proxy error:`, error);

    Sentry.startSpan({ name: "db.insert.requestLogError" }, async () => {
      await logRequest(c, {
        model: "unknown",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        request: {},
        response: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        duration,
      });
    });

    throw new HTTPException(500, { message: "Internal server error" });
  }
}

proxy.get("/models", async (c) => {
  try {
    const data = await fetchLanguageModels();
    return c.json(data);
  } catch (error) {
    console.error("Models fetch error:", error);
    throw new HTTPException(500, { message: "Failed to fetch models" });
  }
});

proxy.get("/embeddings/models", async (c) => {
  try {
    const data = await fetchEmbeddingModels();
    return c.json(data);
  } catch (error) {
    console.error("Embedding models fetch error:", error);
    throw new HTTPException(500, {
      message: "Failed to fetch embedding models",
    });
  }
});

proxy.get("/stats", standardLimiter, async (c) => {
  const user = c.get("user");

  const stats = await Sentry.startSpan(
    { name: "db.select.userStats" },
    async () => {
      return await db
        .select({
          totalRequests: sql<number>`COUNT(*)::int`,
          totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
          totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
          totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
        })
        .from(requestLogs)
        .where(eq(requestLogs.userId, user.id));
    },
  );

  return c.json(
    stats[0] || {
      totalRequests: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    },
  );
});

proxy.post("/chat/completions", standardLimiter, (c) =>
  handleCompletionRequest(c, chatCompletionsConfig),
);

proxy.post("/responses", standardLimiter, (c) =>
  handleCompletionRequest(c, responsesConfig),
);

proxy.post("/embeddings", standardLimiter, async (c) => {
  const user = c.get("user");
  const startTime = Date.now();

  try {
    const requestBody = (await c.req.json()) as {
      model: string;
      user?: string;
    };

    const allowedSet = new Set(allowedEmbeddingModels);
    if (!allowedSet.has(requestBody.model)) {
      requestBody.model = allowedEmbeddingModels[0];
    }

    requestBody.user = `user_${user.id}`;

    const response = await fetch(`${env.OPENAI_API_URL}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        ...openRouterHeaders,
      },
      body: JSON.stringify(requestBody),
    });

    const responseData = (await response.json()) as Record<string, unknown>;
    const duration = Date.now() - startTime;

    const usage = responseData.usage as Record<string, number> | undefined;
    const promptTokens = usage?.prompt_tokens || 0;
    const totalTokens = usage?.total_tokens || 0;

    Sentry.startSpan({ name: "db.insert.requestLog" }, async () => {
      await logRequest(c, {
        model: requestBody.model,
        promptTokens,
        completionTokens: 0,
        totalTokens,
        request: requestBody,
        response: responseData,
        duration,
      });
    });

    return c.json(responseData, response.status as ContentfulStatusCode);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error("Embeddings proxy error:", error);

    Sentry.startSpan({ name: "db.insert.requestLogError" }, async () => {
      await logRequest(c, {
        model: "unknown",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        request: {},
        response: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        duration,
      });
    });

    throw new HTTPException(500, { message: "Internal server error" });
  }
});

proxy.post("/moderations", moderationsLimiter, async (c) => {
  try {
    const requestBody = await c.req.json();

    return honoProxy(env.OPENAI_MODERATION_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_MODERATION_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    console.error("Moderations proxy error:", error);
    throw new HTTPException(500, { message: "Internal server error" });
  }
});

export default proxy;
