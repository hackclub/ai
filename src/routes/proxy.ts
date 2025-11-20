import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { etag } from "hono/etag";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { allowedEmbeddingModels, allowedLanguageModels, env } from "../env";
import { blockAICodingAgents, requireApiKey } from "../middleware/auth";
import type { AppVariables } from "../types";

const proxy = new OpenAPIHono<{ Variables: AppVariables }>();

proxy.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
});

// #region OpenAPI schemas & routes
const ModelSchema = z
  .object({
    id: z.string().openapi({ example: allowedLanguageModels[0] }),
  })
  .openapi("Model");

const ModelsResponseSchema = z
  .object({
    data: z.array(ModelSchema),
  })
  .openapi("ModelsResponse");

const StatsSchema = z
  .object({
    totalRequests: z.number().int().openapi({ example: 10 }),
    totalTokens: z.number().int().openapi({ example: 12345 }),
    totalPromptTokens: z.number().int().openapi({ example: 1000 }),
    totalCompletionTokens: z.number().int().openapi({ example: 2000 }),
  })
  .openapi("Stats");

const MessageSchema = z
  .object({
    role: z.string().openapi({ example: "user" }),
    content: z.string().openapi({ example: "Hello" }),
  })
  .openapi("Message");

const ChatCompletionRequestSchema = z
  .object({
    model: z.string().openapi({ example: allowedLanguageModels[0] }),
    messages: z.array(MessageSchema),
    stream: z.boolean().optional().openapi({ example: false }),
    temperature: z.number().optional().openapi({ example: 1.0 }),
    max_tokens: z.number().nullable().optional().openapi({ example: null }),
    top_p: z.number().optional().openapi({ example: 1.0 }),
  })
  .openapi("ChatCompletionRequest");

const ChatCompletionResponseSchema = z
  .object({
    id: z.string().openapi({ example: "chatcmpl-123" }),
    provider: z.string().optional().openapi({ example: "provider-name" }),
    model: z.string().openapi({ example: allowedLanguageModels[0] }),
    object: z.string().openapi({ example: "chat.completion" }),
    created: z.number().int().openapi({ example: 1677652288 }),
    choices: z.array(
      z.object({
        logprobs: z.null().optional().openapi({ example: null }),
        finish_reason: z.string().openapi({ example: "stop" }),
        native_finish_reason: z
          .string()
          .optional()
          .openapi({ example: "stop" }),
        index: z.number().int().openapi({ example: 0 }),
        message: z.object({
          role: z.string().openapi({ example: "assistant" }),
          content: z.string().openapi({
            example: "Hello there!",
          }),
          refusal: z.null().optional().openapi({ example: null }),
        }),
      }),
    ),
    system_fingerprint: z.string().optional().openapi({ example: "fp_12345" }),
    usage: z.object({
      prompt_tokens: z.number().int().openapi({ example: 10 }),
      completion_tokens: z.number().int().openapi({ example: 10 }),
      total_tokens: z.number().int().openapi({ example: 20 }),
    }),
  })
  .openapi("ChatCompletionResponse");

const EmbeddingsRequestSchema = z
  .object({
    model: z.string().openapi({ example: allowedEmbeddingModels[0] }),
    input: z
      .union([z.string(), z.array(z.string())])
      .openapi({ example: "Hello world" }),
  })
  .openapi("EmbeddingsRequest");

const EmbeddingsResponseSchema = z
  .object({
    object: z.string().openapi({ example: "list" }),
    data: z.array(
      z.object({
        object: z.string().openapi({ example: "embedding" }),
        embedding: z.array(z.number()).openapi({ example: [0.1, 0.2, 0.3] }),
        index: z.number().int().openapi({ example: 0 }),
      }),
    ),
    model: z.string().openapi({ example: allowedEmbeddingModels[0] }),
    usage: z.object({
      prompt_tokens: z.number().int().openapi({ example: 10 }),
      total_tokens: z.number().int().openapi({ example: 10 }),
    }),
    provider: z.string().optional().openapi({ example: "provider-name" }),
    id: z.string().optional().openapi({ example: "emb-123" }),
  })
  .openapi("EmbeddingsResponse");

const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  summary: "Get Available Models",
  description:
    "List all available models. No authentication required. This endpoint is compatible with the [OpenAI Models API](https://platform.openai.com/docs/api-reference/models/list), so the response format is the same as the OpenAI models endpoint.",

  security: [],
  operationId: "getModels",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ModelsResponseSchema,
        },
      },
      description: "Successful response.",
    },
  },
});

const statsRoute = createRoute({
  method: "get",
  path: "/v1/stats",
  security: [{ Bearer: [] }],
  summary: "Get Token Usage Statistics",
  description:
    "Get token usage statistics for your account. This includes total requests made, tokens consumed (prompt + completion), and breakdowns by token type. Useful for monitoring your API usage and costs.",
  operationId: "getStats",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: StatsSchema,
        },
      },
      description: "Successful response.",
    },
  },
});

const chatRoute = createRoute({
  method: "post",
  path: "/v1/chat/completions",
  summary: "Create Chat Completion",
  description:
    "Create a chat completion for the given conversation (aka prompting the AI). Supports streaming and non-streaming modes. Compatible with [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create). You can use this to integrate with existing OpenAI-compatible libraries and tools.",
  security: [{ Bearer: [] }],
  operationId: "createChatCompletions",
  request: {
    body: {
      content: {
        "application/json": {
          schema: ChatCompletionRequestSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ChatCompletionResponseSchema,
        },
      },
      description: "Successful response.",
    },
  },
});

const embeddingsRoute = createRoute({
  method: "post",
  path: "/v1/embeddings",
  summary: "Create Embeddings",
  description:
    "Generate vector embeddings from text input. You can then store these embeddings in a vector database like [Pinecone](https://www.pinecone.io/) or [pgvector](https://github.com/pgvector/pgvector). Compatible with [OpenAI Embeddings API](https://platform.openai.com/docs/api-reference/embeddings/create).",
  security: [{ Bearer: [] }],
  operationId: "createEmbeddings",
  request: {
    body: {
      content: {
        "application/json": {
          schema: EmbeddingsRequestSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: EmbeddingsResponseSchema,
        },
      },
      description: "Successful response.",
    },
  },
});

// #endregion

let modelsCache: { data: any; timestamp: number } | null = null;
let modelsCacheFetch: Promise<any> | null = null;
const CACHE_TTL = 5 * 60 * 1000;

const openRouterHeaders = {
  "HTTP-Referer": `${env.BASE_URL}/global?utm_source=openrouter`,
  "X-Title": "Hack Club AI",
};

proxy.use("*", blockAICodingAgents);

proxy.use((c, next) => {
  if (
    c.req.path.endsWith("/v1/models") ||
    c.req.path.endsWith("/openapi.json")
  ) {
    return next();
  }
  return requireApiKey(c, next);
});

proxy.use("/v1/models", etag());

function getClientIp(c: any): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
    c.req.header("X-Real-IP") ||
    "unknown"
  );
}

proxy.openapi(modelsRoute, async (c) => {
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

      const data = (await response.json()) as any;

      if (!response.ok || !data.data || !Array.isArray(data.data)) {
        modelsCacheFetch = null;
        return data;
      }

      const allAllowedModels = [
        ...allowedLanguageModels,
        ...allowedEmbeddingModels,
      ];

      const allowedSet = new Set(allAllowedModels);
      data.data = data.data.filter((model: any) => allowedSet.has(model.id));

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

proxy.openapi(statsRoute, async (c) => {
  const user = c.get("user");

  const stats = await db
    .select({
      totalRequests: sql<number>`COUNT(*)::int`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)::int`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)::int`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)::int`,
    })
    .from(requestLogs)
    .where(eq(requestLogs.userId, user.id));

  return c.json(
    stats[0] || {
      totalRequests: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    },
    200,
  );
});

proxy.openapi(chatRoute, async (c) => {
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

    const response = await fetch(`${env.OPENAI_API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        ...openRouterHeaders,
      },
      body: JSON.stringify(requestBody),
    });

    if (!isStreaming) {
      const responseData = (await response.json()) as any;
      const duration = Date.now() - startTime;

      const promptTokens = responseData.usage?.prompt_tokens || 0;
      const completionTokens = responseData.usage?.completion_tokens || 0;
      const totalTokens = responseData.usage?.total_tokens || 0;

      db.insert(requestLogs)
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

      return c.json(responseData, response.status as any);
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

        db.insert(requestLogs)
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
      }
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error("Proxy error:", error);

    db.insert(requestLogs)
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

    throw new HTTPException(500, { message: "Internal server error" });
  }
});

proxy.openapi(embeddingsRoute, async (c) => {
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

    const responseData = (await response.json()) as any;
    const duration = Date.now() - startTime;

    const promptTokens = responseData.usage?.prompt_tokens || 0;
    const totalTokens = responseData.usage?.total_tokens || 0;

    db.insert(requestLogs)
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

    return c.json(responseData, response.status as any);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error("Embeddings proxy error:", error);

    db.insert(requestLogs)
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

    throw new HTTPException(500, { message: "Internal server error" });
  }
});

proxy.get("/openapi.json", async (c) => {
  const doc = proxy.getOpenAPI31Document(
    {
      openapi: "3.1.0",
      info: { title: "Hack Club AI", version: "1.0.0" },
    },
    undefined,
  );

  const origin = new URL(c.req.url).origin;
  doc.servers = [
    {
      url: `${origin}/proxy`,
      description: "Base path",
    },
  ];

  doc.info.description =
    "Authentication: All endpoints require `Authorization: Bearer <token>`.\n\n GET /v1/models is public.";

  // bearer req by default
  doc.security = [{ Bearer: [] }];

  try {
    if (doc.paths?.["/v1/models"]?.get) {
      doc.paths["/v1/models"].get.security = [];
    }
  } catch (e) {}

  return c.json(doc);
});

export default proxy;
