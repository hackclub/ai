import * as Sentry from "@sentry/bun";
import { eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { etag } from "hono/etag";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { allowedEmbeddingModels, allowedLanguageModels, env } from "../env";
import { blockAICodingAgents, requireApiKey } from "../middleware/auth";
import type { AppVariables } from "../types";

interface OpenRouterModel {
  id: string;
  [key: string]: unknown;
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIChatCompletionResponse {
  usage?: OpenAIUsage;
  [key: string]: unknown;
}

interface OpenAIEmbeddingsResponse {
  usage?: OpenAIUsage;
  [key: string]: unknown;
}

const proxy = new Hono<{ Variables: AppVariables }>();

let modelsCache: { data: OpenRouterModelsResponse; timestamp: number } | null =
  null;
let modelsCacheFetch: Promise<OpenRouterModelsResponse> | null = null;
const CACHE_TTL = 5 * 60 * 1000;

const openRouterHeaders = {
  "HTTP-Referer": `${env.BASE_URL}/global?utm_source=openrouter`,
  "X-Title": "Hack Club AI",
};

proxy.use("*", blockAICodingAgents);

proxy.use((c, next) => {
  if (c.req.path.endsWith("/v1/models")) {
    return next();
  }
  return requireApiKey(c, next);
});

proxy.use("/v1/models", etag());

function getClientIp(c: Context): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
    c.req.header("X-Real-IP") ||
    "unknown"
  );
}

proxy.get("/v1/models", async (c) => {
  return Sentry.startSpan({ name: "GET /v1/models" }, async () => {
    const now = Date.now();

    if (modelsCache && now - modelsCache.timestamp < CACHE_TTL) {
      return c.json(modelsCache.data);
    }

    if (modelsCacheFetch) {
      try {
        const data = await modelsCacheFetch;
        return c.json(data);
      } catch (error) {
        console.error("Models fetch error:", error);
        throw new HTTPException(500, { message: "Failed to fetch models" });
      }
    }

    modelsCacheFetch = (async () => {
      try {
        const response = await fetch(`${env.OPENAI_API_URL}/v1/models`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            ...openRouterHeaders,
          },
        });

        const data = (await response.json()) as OpenRouterModelsResponse;

        if (!response.ok || !data.data || !Array.isArray(data.data)) {
          modelsCacheFetch = null;
          return data;
        }

        const allAllowedModels = [
          ...allowedLanguageModels,
          ...allowedEmbeddingModels,
        ];

        const allowedSet = new Set(allAllowedModels);
        data.data = data.data.filter((model) => allowedSet.has(model.id));

        modelsCache = { data, timestamp: now };
        modelsCacheFetch = null;

        return data;
      } catch (error) {
        modelsCacheFetch = null;
        throw error;
      }
    })();

    try {
      const data = await modelsCacheFetch;
      return c.json(data);
    } catch (error) {
      console.error("Models fetch error:", error);
      throw new HTTPException(500, { message: "Failed to fetch models" });
    }
  });
});

proxy.get("/v1/stats", async (c) => {
  return Sentry.startSpan({ name: "GET /v1/stats" }, async () => {
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
});

proxy.post("/v1/chat/completions", async (c) => {
  return Sentry.startSpan({ name: "POST /v1/chat/completions" }, async () => {
    const apiKey = c.get("apiKey");
    const user = c.get("user");
    const startTime = Date.now();

    try {
      const requestBody = await c.req.json();

      const allowedSet = new Set(allowedLanguageModels);
      if (!allowedSet.has(requestBody.model)) {
        requestBody.model = allowedLanguageModels[0];
      }

      requestBody.user = `user_${user.id}`;

      const isStreaming = requestBody.stream === true;

      const response = await fetch(
        `${env.OPENAI_API_URL}/v1/chat/completions`,
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
        const responseData =
          (await response.json()) as OpenAIChatCompletionResponse;
        const duration = Date.now() - startTime;

        const promptTokens = responseData.usage?.prompt_tokens || 0;
        const completionTokens = responseData.usage?.completion_tokens || 0;
        const totalTokens = responseData.usage?.total_tokens || 0;

        Sentry.startSpan({ name: "db.insert.requestLog" }, async () => {
          await db
            .insert(requestLogs)
            .values({
              apiKeyId: apiKey.id,
              userId: user.id,
              slackId: user.slackId,
              model: requestBody.model,
              promptTokens,
              completionTokens,
              totalTokens,
              request: requestBody,
              response: responseData,
              ip: getClientIp(c),
              timestamp: new Date(),
              duration,
            })
            .catch((err) => console.error("Logging error:", err));
        });

        return c.json(responseData, response.status as 200);
      }

      return stream(c, async (stream) => {
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        const chunks: string[] = [];
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;

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
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || 0;
                  completionTokens = parsed.usage.completion_tokens || 0;
                  totalTokens = parsed.usage.total_tokens || 0;
                }
              } catch {}
            }
          }
        } finally {
          const duration = Date.now() - startTime;

          Sentry.startSpan({ name: "db.insert.requestLogStream" }, async () => {
            await db
              .insert(requestLogs)
              .values({
                apiKeyId: apiKey.id,
                userId: user.id,
                slackId: user.slackId,
                model: requestBody.model,
                promptTokens,
                completionTokens,
                totalTokens,
                request: requestBody,
                response: { stream: true, chunks: chunks.join("") },
                ip: getClientIp(c),
                timestamp: new Date(),
                duration,
              })
              .catch((err) => console.error("Logging error:", err));
          });
        }
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error("Proxy error:", error);

      Sentry.startSpan({ name: "db.insert.requestLogError" }, async () => {
        await db
          .insert(requestLogs)
          .values({
            apiKeyId: apiKey.id,
            userId: user.id,
            slackId: user.slackId,
            model: "unknown",
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            request: {},
            response: {
              error: error instanceof Error ? error.message : "Unknown error",
            },
            ip: getClientIp(c),
            timestamp: new Date(),
            duration,
          })
          .catch((err) => console.error("Logging error:", err));
      });

      throw new HTTPException(500, { message: "Internal server error" });
    }
  });
});

proxy.post("/v1/embeddings", async (c) => {
  return Sentry.startSpan({ name: "POST /v1/embeddings" }, async () => {
    const apiKey = c.get("apiKey");
    const user = c.get("user");
    const startTime = Date.now();

    try {
      const requestBody = await c.req.json();

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

      const responseData = (await response.json()) as OpenAIEmbeddingsResponse;
      const duration = Date.now() - startTime;

      const promptTokens = responseData.usage?.prompt_tokens || 0;
      const totalTokens = responseData.usage?.total_tokens || 0;

      Sentry.startSpan({ name: "db.insert.requestLog" }, async () => {
        await db
          .insert(requestLogs)
          .values({
            apiKeyId: apiKey.id,
            userId: user.id,
            slackId: user.slackId,
            model: requestBody.model,
            promptTokens,
            completionTokens: 0,
            totalTokens,
            request: requestBody,
            response: responseData,
            ip: getClientIp(c),
            timestamp: new Date(),
            duration,
          })
          .catch((err) => console.error("Logging error:", err));
      });

      return c.json(responseData, response.status as 200);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error("Embeddings proxy error:", error);

      Sentry.startSpan({ name: "db.insert.requestLogError" }, async () => {
        await db
          .insert(requestLogs)
          .values({
            apiKeyId: apiKey.id,
            userId: user.id,
            slackId: user.slackId,
            model: "unknown",
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            request: {},
            response: {
              error: error instanceof Error ? error.message : "Unknown error",
            },
            ip: getClientIp(c),
            timestamp: new Date(),
            duration,
          })
          .catch((err) => console.error("Logging error:", err));
      });

      throw new HTTPException(500, { message: "Internal server error" });
    }
  });
});

export default proxy;
