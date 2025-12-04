import * as Sentry from "@sentry/bun";
import type { type } from "arktype";
import { eq, sql } from "drizzle-orm";
import { type Context, Hono, type TypedResponse } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { HTTPException } from "hono/http-exception";
import { proxy as honoProxy } from "hono/proxy";
import { stream } from "hono/streaming";
import { timeout } from "hono/timeout";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { rateLimiter } from "hono-rate-limiter";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { allowedEmbeddingModels, allowedLanguageModels, env } from "../env";
import { fetchAllModels } from "../lib/models";
import { blockAICodingAgents, requireApiKey } from "../middleware/auth";
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  EmbeddingsRequestSchema,
  EmbeddingsResponseSchema,
  ModelsResponseSchema,
  ModerationRequestSchema,
  ModerationResponseSchema,
  StatsSchema,
} from "../openapi";
import type { AppVariables } from "../types";

type OpenAIChatCompletionResponse = type.infer<
  typeof ChatCompletionResponseSchema
>;
type OpenAIEmbeddingsResponse = type.infer<typeof EmbeddingsResponseSchema>;

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
  rateLimiter({
    windowMs: 30 * 60 * 1000, // 30 minutes
    limit: 150,
    standardHeaders: "draft-6", // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
    keyGenerator: (c: Context<{ Variables: AppVariables }>) =>
      c.get("user")?.id || c.get("ip"),
  }),
);

// #region OpenAPI schemas & routes

const modelsRoute = describeRoute({
  summary: "Get available models",
  description:
    "List all available models. No authentication required. This endpoint is compatible with the [OpenAI Models API](https://platform.openai.com/docs/api-reference/models/list), so the response format is the same as the OpenAI models endpoint.",
  responses: {
    200: {
      description: "Successful response.",
      content: {
        "application/json": {
          schema: resolver(ModelsResponseSchema),
        },
      },
    },
  },
});

const statsRoute = describeRoute({
  summary: "Get token usage statistics",
  description:
    "Get token usage statistics for your account. This includes total requests made, tokens consumed (prompt + completion), and breakdowns by token type. Useful for monitoring your API usage and costs.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Successful response.",
      content: {
        "application/json": {
          schema: resolver(StatsSchema),
        },
      },
    },
  },
});

const chatRoute = describeRoute({
  summary: "Create chat completion",
  description:
    "Create a chat completion for the given conversation (aka prompting the AI). Supports streaming and non-streaming modes. Compatible with [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create). You can use this to integrate with existing OpenAI-compatible libraries and tools.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Successful response.",
      content: {
        "application/json": {
          schema: resolver(ChatCompletionResponseSchema),
        },
      },
    },
  },
});

const embeddingsRoute = describeRoute({
  summary: "Create embeddings",
  description:
    "Generate vector embeddings from text input. You can then store these embeddings in a vector database like [Pinecone](https://www.pinecone.io/) or [pgvector](https://github.com/pgvector/pgvector). Compatible with [OpenAI Embeddings API](https://platform.openai.com/docs/api-reference/embeddings/create).",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Successful response.",
      content: {
        "application/json": {
          schema: resolver(EmbeddingsResponseSchema),
        },
      },
    },
  },
});

const moderationsRoute = describeRoute({
  summary: "Create moderation",
  description:
    "Classify if the text and/or image inputted is potentially inappropriate (e.g. hate speech, violence, NSFW etc.). Compatible with [OpenAI Moderations API](https://platform.openai.com/docs/api-reference/moderations/create).",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Successful response.",
      content: {
        "application/json": {
          schema: resolver(ModerationResponseSchema),
        },
      },
    },
  },
});

// #endregion

const openRouterHeaders = {
  "HTTP-Referer": `${env.BASE_URL}/global?utm_source=openrouter`,
  "X-Title": "Hack Club AI",
};

proxy.use("*", blockAICodingAgents);

proxy.use((c, next) => {
  if (c.req.path.endsWith("/models") || c.req.path.endsWith("/openapi.json")) {
    return next();
  }
  return requireApiKey(c, next);
});

proxy.use("/models", etag());

function getRequestHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

proxy.get("/models", modelsRoute, async (c) => {
  return Sentry.startSpan({ name: "GET /models" }, async () => {
    try {
      const { languageModels, embeddingModels } = await fetchAllModels();
      return c.json({
        data: [...languageModels, ...embeddingModels],
      });
    } catch (error) {
      console.error("Models fetch error:", error);
      throw new HTTPException(500, { message: "Failed to fetch models" });
    }
  });
});

proxy.get("/stats", statsRoute, async (c) => {
  return Sentry.startSpan({ name: "GET /stats" }, async () => {
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

proxy.post(
  "/chat/completions",
  chatRoute,
  validator("json", ChatCompletionRequestSchema),
  async (c) => {
    return Sentry.startSpan({ name: "POST /chat/completions" }, async () => {
      const apiKey = c.get("apiKey");
      const user = c.get("user");
      const startTime = Date.now();

      try {
        const requestBody = c.req.valid("json");

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
                headers: getRequestHeaders(c),
                ip: c.get("ip"),
                timestamp: new Date(),
                duration,
              })
              .catch((err) => console.error("Logging error:", err));
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

            Sentry.startSpan(
              { name: "db.insert.requestLogStream" },
              async () => {
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
                    headers: getRequestHeaders(c),
                    ip: c.get("ip"),
                    timestamp: new Date(),
                    duration,
                  })
                  .catch((err) => console.error("Logging error:", err));
              },
            );
          }
        }) as unknown as TypedResponse<
          OpenAIChatCompletionResponse,
          ContentfulStatusCode
        >;
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
              headers: getRequestHeaders(c),
              ip: c.get("ip"),
              timestamp: new Date(),
              duration,
            })
            .catch((err) => console.error("Logging error:", err));
        });

        throw new HTTPException(500, { message: "Internal server error" });
      }
    });
  },
);

proxy.post(
  "/embeddings",
  embeddingsRoute,
  validator("json", EmbeddingsRequestSchema),
  async (c) => {
    return Sentry.startSpan({ name: "POST /embeddings" }, async () => {
      const apiKey = c.get("apiKey");
      const user = c.get("user");
      const startTime = Date.now();

      try {
        const requestBody = c.req.valid("json");

        const allowedSet = new Set(allowedEmbeddingModels);
        if (!allowedSet.has(requestBody.model)) {
          requestBody.model = allowedEmbeddingModels[0];
        }

        // @ts-expect-error: user is not in schema but we need to pass it
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

        const responseData =
          (await response.json()) as OpenAIEmbeddingsResponse;
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
              headers: getRequestHeaders(c),
              ip: c.get("ip"),
              timestamp: new Date(),
              duration,
            })
            .catch((err) => console.error("Logging error:", err));
        });

        return c.json(responseData, response.status as ContentfulStatusCode);
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
              headers: getRequestHeaders(c),
              ip: c.get("ip"),
              timestamp: new Date(),
              duration,
            })
            .catch((err) => console.error("Logging error:", err));
        });

        throw new HTTPException(500, { message: "Internal server error" });
      }
    });
  },
);

proxy.post(
  "/moderations",
  moderationsRoute,
  validator("json", ModerationRequestSchema),
  async (c) => {
    return Sentry.startSpan({ name: "POST /moderations" }, async () => {
      // We don't log moderations requests
      try {
        const requestBody = c.req.valid("json");

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
  },
);

proxy.get(
  "/openapi.json",
  openAPIRouteHandler(proxy, {
    documentation: {
      info: {
        title: "Hack Club AI",
        version: "1.0.0",
        description:
          "Authentication: All endpoints require `Authorization: Bearer <token>`.\n\n GET /v1/models is public.",
      },
      servers: [
        {
          url: "https://ai.hackclub.com/proxy",
          description: "Production",
        },
      ],
      security: [{ Bearer: [] }],
      components: {
        securitySchemes: {
          Bearer: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
  }),
);

export default proxy;
