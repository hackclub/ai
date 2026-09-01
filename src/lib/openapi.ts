import { DOCS_URL } from "./errors";
import { SITE_DESCRIPTION } from "./site";

type OpenApiOptions = {
  baseUrl: string;
  languageModels: string[];
  imageModels: string[];
  embeddingModels: string[];
};

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/**
 * Hand-written OpenAPI 3.2 description of the public HTTP surface.
 *
 * The proxy forwards most bodies to OpenRouter, Mistral, Exa or Replicate
 * largely untouched, so request/response schemas here are deliberately open
 * (`additionalProperties: true`) and document the fields this service reads,
 * validates or bills on rather than restating each upstream's full schema.
 */
export const buildOpenApiDocument = ({
  baseUrl,
  languageModels,
  imageModels,
  embeddingModels,
}: OpenApiOptions): Record<string, unknown> => {
  const base = trimTrailingSlash(baseUrl);

  const errorResponse = (description: string) => ({
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
      },
    },
  });

  const commonErrors = {
    "400": errorResponse(
      "The request body was malformed or failed validation.",
    ),
    "401": errorResponse("Missing or invalid API key."),
    "403": errorResponse(
      "The account is banned, not identity-verified, or the client is a blocked AI coding agent.",
    ),
    "429": errorResponse(
      "Rate limit or daily spending limit exceeded for this account.",
    ),
    "500": errorResponse("Unexpected server error."),
    "504": errorResponse("The upstream provider did not respond in time."),
  };

  const passthroughRequest = (description: string, example?: unknown) => ({
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: true,
          description,
        },
        ...(example === undefined ? {} : { example }),
      },
    },
  });

  const pathParam = (name: string, description: string) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description,
  });

  const predictionIdParam = pathParam(
    "id",
    "Replicate prediction id (lowercase alphanumeric).",
  );
  const fileIdParam = pathParam("id", "Replicate file id.");
  const ownerParam = pathParam(
    "owner",
    "Replicate model owner, e.g. `openai`.",
  );
  const modelParam = pathParam(
    "model",
    "Replicate model name, optionally with a `:version` suffix.",
  );
  const deploymentNameParam = pathParam("name", "Replicate deployment name.");

  const passthroughResponse = (description: string) => ({
    description,
    content: {
      "application/json": {
        schema: { type: "object", additionalProperties: true },
      },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Hack Club AI",
      version: "1.0.0",
      summary: "Free, OpenAI-compatible AI API for Hack Clubbers.",
      description: [
        SITE_DESCRIPTION,
        "",
        `Point any OpenAI-compatible SDK at \`${base}/proxy/v1\` and pass a Hack Club AI key as a bearer token.`,
        `Create a key at ${base}/keys after signing in with a Hack Club account.`,
        "",
        "Errors are always JSON in the OpenAI error shape, with two extra fields: `error.hint` (what to do about it) and `error.docs` (where to read more).",
      ].join("\n"),
      termsOfService: `${DOCS_URL}/guide/rules`,
      contact: {
        name: "Hack Club",
        email: "team@hackclub.com",
        url: "https://hackclub.com/slack",
      },
      license: {
        name: "MIT",
        identifier: "MIT",
      },
    },
    externalDocs: {
      description: "Hack Club AI documentation",
      url: DOCS_URL,
    },
    servers: [{ url: base, description: "Production" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Models", description: "Discover which models are available." },
      { name: "Chat", description: "Text generation, OpenAI-compatible." },
      { name: "Embeddings", description: "Vector embeddings." },
      { name: "Images", description: "Image generation." },
      { name: "Moderation", description: "Content classification." },
      { name: "OCR", description: "Text extraction from images and PDFs." },
      { name: "Search", description: "Web search and retrieval via Exa." },
      {
        name: "Replicate",
        description:
          "Replicate models for image, speech-to-text and text-to-speech. Gated behind a per-account feature flag.",
      },
      { name: "Account", description: "Usage statistics for the calling key." },
      { name: "Service", description: "Health and status." },
    ],
    paths: {
      "/proxy/v1/models": {
        get: {
          tags: ["Models"],
          operationId: "listModels",
          summary: "List chat and image models",
          description:
            "Returns every language and image model this proxy will accept, in the OpenAI `GET /v1/models` shape. No authentication required.",
          security: [],
          responses: {
            "200": {
              description: "The available chat and image models.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ModelList" },
                },
              },
            },
            "403": commonErrors["403"],
            "500": commonErrors["500"],
          },
        },
      },
      "/proxy/v1/embeddings/models": {
        get: {
          tags: ["Models"],
          operationId: "listEmbeddingModels",
          summary: "List embedding models",
          description:
            "Returns every embedding model this proxy will accept, in the OpenRouter models shape. No authentication required.",
          security: [],
          responses: {
            "200": {
              description: "The available embedding models.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ModelList" },
                },
              },
            },
            "403": commonErrors["403"],
            "500": commonErrors["500"],
          },
        },
      },
      "/proxy/v1/chat/completions": {
        post: {
          tags: ["Chat"],
          operationId: "createChatCompletion",
          summary: "Create a chat completion",
          description:
            "OpenAI-compatible chat completions. Supports streaming (`stream: true`, server-sent events), vision inputs, PDF inputs and image output modalities. Usage and cost are recorded against the calling key.",
          externalDocs: { url: `${DOCS_URL}/api/chat-completions` },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatCompletionRequest" },
                example: {
                  model: languageModels[0] ?? "qwen/qwen3-32b",
                  messages: [{ role: "user", content: "Tell me a joke." }],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "A chat completion. `text/event-stream` when `stream` is true.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ChatCompletionResponse",
                  },
                },
                "text/event-stream": {
                  schema: {
                    type: "string",
                    description:
                      "OpenAI-style SSE chunks, terminated by `data: [DONE]`.",
                  },
                },
              },
            },
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/responses": {
        post: {
          tags: ["Chat"],
          operationId: "createResponse",
          summary: "Create a response (Responses API)",
          description:
            "OpenAI Responses API equivalent. Accepts simple text input, structured messages and streaming.",
          externalDocs: { url: `${DOCS_URL}/api/responses` },
          requestBody: passthroughRequest(
            "An OpenAI Responses API request. `model` is required.",
            {
              model: languageModels[0] ?? "qwen/qwen3-32b",
              input: "Write a haiku about Vermont.",
            },
          ),
          responses: {
            "200": passthroughResponse(
              "A response object. `text/event-stream` when `stream` is true.",
            ),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/embeddings": {
        post: {
          tags: ["Embeddings"],
          operationId: "createEmbedding",
          summary: "Create embeddings",
          description:
            "OpenAI-compatible embeddings. Pass a single string or an array of strings.",
          externalDocs: { url: `${DOCS_URL}/api/embeddings` },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EmbeddingRequest" },
                example: {
                  model: embeddingModels[0] ?? "qwen/qwen3-embedding-8b",
                  input: "The quick brown fox jumps over the lazy dog",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The embedding vectors.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EmbeddingResponse" },
                },
              },
            },
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/images/generations": {
        post: {
          tags: ["Images"],
          operationId: "createImage",
          summary: "Generate an image",
          description:
            "OpenAI-compatible image generation. `size` is mapped to the nearest supported aspect ratio (1:1, 16:9, 9:16).",
          externalDocs: { url: `${DOCS_URL}/api/image-generation` },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ImageRequest" },
                example: {
                  model: imageModels[0] ?? "google/gemini-2.5-flash-image",
                  prompt: "A pixel-art orpheus the dinosaur waving a flag",
                  size: "1024x1024",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The generated images.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ImageResponse" },
                },
              },
            },
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/moderations": {
        post: {
          tags: ["Moderation"],
          operationId: "createModeration",
          summary: "Classify text or images",
          description:
            "OpenAI-compatible moderation. Classifies whether input is potentially harmful.",
          externalDocs: { url: `${DOCS_URL}/api/moderations` },
          requestBody: passthroughRequest("An OpenAI moderations request.", {
            model: "omni-moderation-latest",
            input: "I want to hurt someone.",
          }),
          responses: {
            "200": passthroughResponse("The moderation result."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/ocr": {
        post: {
          tags: ["OCR"],
          operationId: "createOcr",
          summary: "Extract text from an image or PDF",
          description:
            "Runs OCR over an image or document and returns markdown per page. Gated behind the `enable_ocr` feature flag; accounts without it get 403.",
          externalDocs: { url: `${DOCS_URL}/api/ocr` },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OcrRequest" },
                example: {
                  document: {
                    type: "document_url",
                    document_url: "https://example.com/invoice.pdf",
                  },
                },
              },
            },
          },
          responses: {
            "200": passthroughResponse("Pages of extracted markdown."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/exa/search": {
        post: {
          tags: ["Search"],
          operationId: "exaSearch",
          summary: "Search the web",
          description:
            "Neural or keyword web search via Exa, optionally returning page contents. Gated behind the `enable_exa` feature flag; accounts without it get 403.",
          externalDocs: { url: `${DOCS_URL}/api/exa` },
          requestBody: passthroughRequest("An Exa `/search` request.", {
            query: "best resources for learning Rust",
            numResults: 5,
          }),
          responses: {
            "200": passthroughResponse("Exa search results."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/exa/findSimilar": {
        post: {
          tags: ["Search"],
          operationId: "exaFindSimilar",
          summary: "Find pages similar to a URL",
          externalDocs: { url: `${DOCS_URL}/api/exa` },
          requestBody: passthroughRequest("An Exa `/findSimilar` request.", {
            url: "https://hackclub.com",
            numResults: 5,
          }),
          responses: {
            "200": passthroughResponse("Similar pages."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/exa/contents": {
        post: {
          tags: ["Search"],
          operationId: "exaContents",
          summary: "Fetch live page contents",
          externalDocs: { url: `${DOCS_URL}/api/exa` },
          requestBody: passthroughRequest("An Exa `/contents` request.", {
            urls: ["https://hackclub.com"],
            text: true,
          }),
          responses: {
            "200": passthroughResponse("Page contents."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/exa/answer": {
        post: {
          tags: ["Search"],
          operationId: "exaAnswer",
          summary: "Answer a question with cited sources",
          description:
            "Supports `stream: true`, in which case the response is `text/event-stream`.",
          externalDocs: { url: `${DOCS_URL}/api/exa` },
          requestBody: passthroughRequest("An Exa `/answer` request.", {
            query: "When was Hack Club founded?",
          }),
          responses: {
            "200": passthroughResponse(
              "An answer with sources. `text/event-stream` when `stream` is true.",
            ),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/predictions": {
        get: {
          tags: ["Replicate"],
          operationId: "listReplicatePredictions",
          summary: "List your Replicate predictions",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          responses: {
            "200": passthroughResponse("A page of predictions."),
            ...commonErrors,
          },
        },
        post: {
          tags: ["Replicate"],
          operationId: "createReplicatePrediction",
          summary: "Create a prediction",
          description:
            "Send either `model` (owner/name) or a `version` that maps to an allowed model. Models outside the allow-list are rejected with 403.",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          requestBody: passthroughRequest("A Replicate prediction request.", {
            model: "black-forest-labs/flux-schnell",
            input: { prompt: "a red flag on a mountain" },
          }),
          responses: {
            "200": passthroughResponse("The created prediction."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/predictions/{id}": {
        get: {
          tags: ["Replicate"],
          operationId: "getReplicatePrediction",
          summary: "Get a prediction",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [predictionIdParam],
          responses: {
            "200": passthroughResponse("The prediction."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/predictions/{id}/cancel": {
        post: {
          tags: ["Replicate"],
          operationId: "cancelReplicatePrediction",
          summary: "Cancel a running prediction",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [predictionIdParam],
          responses: {
            "200": passthroughResponse("The cancelled prediction."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/models/{owner}/{model}": {
        get: {
          tags: ["Replicate"],
          operationId: "getReplicateModel",
          summary: "Get an allowed Replicate model",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [ownerParam, modelParam],
          responses: {
            "200": passthroughResponse("The model."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/models/{owner}/{model}/predictions": {
        post: {
          tags: ["Replicate"],
          operationId: "createReplicateModelPrediction",
          summary: "Run an allowed Replicate model",
          description:
            "`model` may carry a `:version` suffix, which must match the allow-list.",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [ownerParam, modelParam],
          requestBody: passthroughRequest("A Replicate prediction input.", {
            input: { prompt: "a red flag on a mountain" },
          }),
          responses: {
            "200": passthroughResponse("The created prediction."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/models/{owner}/{model}/versions": {
        get: {
          tags: ["Replicate"],
          operationId: "listReplicateModelVersions",
          summary: "List versions of an allowed model",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [ownerParam, modelParam],
          responses: {
            "200": passthroughResponse("The model's versions."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/models/{owner}/{model}/versions/{id}": {
        get: {
          tags: ["Replicate"],
          operationId: "getReplicateModelVersion",
          summary: "Get one version of an allowed model",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [
            ownerParam,
            modelParam,
            pathParam("id", "Replicate model version id."),
          ],
          responses: {
            "200": passthroughResponse("The model version."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/deployments": {
        get: {
          tags: ["Replicate"],
          operationId: "listReplicateDeployments",
          summary: "List available deployments",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          responses: {
            "200": passthroughResponse("The deployments."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/deployments/{owner}/{name}": {
        get: {
          tags: ["Replicate"],
          operationId: "getReplicateDeployment",
          summary: "Get a deployment",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [ownerParam, deploymentNameParam],
          responses: {
            "200": passthroughResponse("The deployment."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/deployments/{owner}/{name}/predictions": {
        post: {
          tags: ["Replicate"],
          operationId: "createReplicateDeploymentPrediction",
          summary: "Run a deployment",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [ownerParam, deploymentNameParam],
          requestBody: passthroughRequest("A Replicate prediction input.", {
            input: { prompt: "a red flag on a mountain" },
          }),
          responses: {
            "200": passthroughResponse("The created prediction."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/files": {
        post: {
          tags: ["Replicate"],
          operationId: "uploadReplicateFile",
          summary: "Upload a file for use as model input",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["content"],
                  properties: {
                    content: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
          responses: {
            "200": passthroughResponse("The uploaded file."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/replicate/files/{id}": {
        get: {
          tags: ["Replicate"],
          operationId: "getReplicateFile",
          summary: "Get an uploaded file",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [fileIdParam],
          responses: {
            "200": passthroughResponse("The file."),
            ...commonErrors,
          },
        },
        delete: {
          tags: ["Replicate"],
          operationId: "deleteReplicateFile",
          summary: "Delete an uploaded file",
          externalDocs: { url: `${DOCS_URL}/guide/replicate` },
          parameters: [fileIdParam],
          responses: {
            "200": passthroughResponse("The deletion result."),
            ...commonErrors,
          },
        },
      },
      "/proxy/v1/stats": {
        get: {
          tags: ["Account"],
          operationId: "getStats",
          summary: "Get usage statistics",
          description:
            "Lifetime token and request totals for the account that owns the calling API key.",
          externalDocs: { url: `${DOCS_URL}/api/stats` },
          responses: {
            "200": {
              description: "Usage totals.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Stats" },
                },
              },
            },
            "401": commonErrors["401"],
            "403": commonErrors["403"],
            "429": commonErrors["429"],
          },
        },
      },
      "/up": {
        get: {
          tags: ["Service"],
          operationId: "getHealth",
          summary: "Health check",
          description:
            'Returns 200 with `status: "up"` when the service can reach its upstream providers and has credit, and 503 with `status: "down"` otherwise. Cached for 30 seconds.',
          externalDocs: { url: `${DOCS_URL}/api/healthcheck` },
          security: [],
          responses: {
            "200": {
              description: "The service is up.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthUp" },
                },
              },
            },
            "503": {
              description: "The service is down.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthDown" },
                },
              },
            },
            "429": commonErrors["429"],
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["Service"],
          operationId: "getOpenApiDocument",
          summary: "This document",
          description:
            "Also served, byte for byte, from `/.well-known/openapi.json`.",
          security: [],
          responses: {
            "200": passthroughResponse(
              "The OpenAPI 3.2 description of this API.",
            ),
          },
        },
      },
      "/robots.txt": {
        get: {
          tags: ["Service"],
          operationId: "getRobotsTxt",
          summary: "Crawler policy",
          security: [],
          responses: {
            "200": {
              description: "The robots.txt document.",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/llms.txt": {
        get: {
          tags: ["Service"],
          operationId: "getLlmsTxt",
          summary: "Agent-readable index of this site",
          description: "An llms.txt document, per https://llmstxt.org.",
          security: [],
          responses: {
            "200": {
              description: "The llms.txt document.",
              content: { "text/markdown": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/sitemap.xml": {
        get: {
          tags: ["Service"],
          operationId: "getSitemap",
          summary: "XML sitemap",
          security: [],
          responses: {
            "200": {
              description: "The sitemap.",
              content: { "application/xml": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A Hack Club AI API key, sent as `Authorization: Bearer sk-hc-v1-...`. Create one at /keys.",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["error"],
          description:
            "Every error from this API uses this shape. It is a superset of the OpenAI error object.",
          properties: {
            error: {
              type: "object",
              required: ["message", "type", "code", "status", "hint", "docs"],
              properties: {
                message: {
                  type: "string",
                  description: "Human-readable description of what went wrong.",
                },
                type: {
                  type: "string",
                  description: "OpenAI-compatible error class.",
                  examples: [
                    "invalid_request_error",
                    "authentication_error",
                    "permission_error",
                    "rate_limit_error",
                    "api_error",
                  ],
                },
                code: {
                  type: "string",
                  description: "Stable machine-readable error code.",
                  examples: [
                    "invalid_request",
                    "unauthorized",
                    "forbidden",
                    "not_found",
                    "rate_limit_exceeded",
                    "upstream_timeout",
                  ],
                },
                status: {
                  type: "integer",
                  description:
                    "The HTTP status code, repeated for convenience.",
                },
                hint: {
                  type: "string",
                  description: "What to do to resolve the error.",
                },
                docs: {
                  type: "string",
                  format: "uri",
                  description: "Documentation covering this error.",
                },
              },
            },
            request_id: {
              type: "string",
              description:
                "Correlation id for this request; quote it when asking for support.",
            },
          },
          example: {
            error: {
              message: "Authentication required",
              type: "authentication_error",
              code: "unauthorized",
              status: 401,
              hint: "Send `Authorization: Bearer sk-hc-v1-...`. Create a key at https://ai.hackclub.com/keys.",
              docs: `${DOCS_URL}/guide/authentication`,
            },
          },
        },
        Model: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string", examples: languageModels.slice(0, 3) },
            object: { type: "string", const: "model" },
            created: { type: "integer" },
            owned_by: { type: "string" },
          },
        },
        ModelList: {
          type: "object",
          required: ["data"],
          properties: {
            object: { type: "string", const: "list" },
            data: {
              type: "array",
              items: { $ref: "#/components/schemas/Model" },
            },
          },
        },
        ChatMessage: {
          type: "object",
          required: ["role"],
          additionalProperties: true,
          properties: {
            role: {
              type: "string",
              enum: ["system", "developer", "user", "assistant", "tool"],
            },
            content: {
              description:
                "A string, or an array of content parts for vision and PDF inputs.",
              anyOf: [
                { type: "string" },
                {
                  type: "array",
                  items: { type: "object", additionalProperties: true },
                },
              ],
            },
          },
        },
        ChatCompletionRequest: {
          type: "object",
          required: ["model", "messages"],
          additionalProperties: true,
          description:
            "Any OpenAI chat completion field may be sent; unlisted fields are forwarded upstream unchanged.",
          properties: {
            model: {
              type: "string",
              description:
                "Model id. Call GET /proxy/v1/models for the current list.",
              examples: languageModels.slice(0, 5),
            },
            messages: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/components/schemas/ChatMessage" },
            },
            stream: {
              type: "boolean",
              default: false,
              description: "Stream the response as server-sent events.",
            },
            temperature: { type: "number", minimum: 0, maximum: 2, default: 1 },
            top_p: { type: "number", minimum: 0, maximum: 1, default: 1 },
            max_tokens: {
              type: "integer",
              minimum: 1,
              description:
                "Setting this lowers the cost reserved against your daily limit before the request runs.",
            },
            modalities: {
              type: "array",
              items: { type: "string", enum: ["text", "image"] },
              description: "Request image output from an image-capable model.",
            },
            tools: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
        ChatCompletionResponse: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            object: { type: "string", const: "chat.completion" },
            created: { type: "integer" },
            model: { type: "string" },
            choices: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            usage: { $ref: "#/components/schemas/Usage" },
          },
        },
        EmbeddingRequest: {
          type: "object",
          required: ["model", "input"],
          additionalProperties: true,
          properties: {
            model: {
              type: "string",
              description:
                "Embedding model id. Call GET /proxy/v1/embeddings/models for the current list.",
              examples: embeddingModels.slice(0, 3),
            },
            input: {
              description: "Text to embed.",
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            encoding_format: { type: "string", enum: ["float", "base64"] },
          },
        },
        EmbeddingResponse: {
          type: "object",
          additionalProperties: true,
          properties: {
            object: { type: "string", const: "list" },
            model: { type: "string" },
            data: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  object: { type: "string", const: "embedding" },
                  index: { type: "integer" },
                  embedding: { type: "array", items: { type: "number" } },
                },
              },
            },
            usage: { $ref: "#/components/schemas/Usage" },
          },
        },
        ImageRequest: {
          type: "object",
          required: ["prompt"],
          additionalProperties: true,
          properties: {
            prompt: { type: "string" },
            model: {
              type: "string",
              examples: imageModels.slice(0, 3),
              description: `Defaults to ${imageModels[0] ?? "the first configured image model"}.`,
            },
            size: {
              type: "string",
              enum: [
                "256x256",
                "512x512",
                "1024x1024",
                "1792x1024",
                "1024x1792",
              ],
              default: "1024x1024",
              description: "Mapped to the nearest supported aspect ratio.",
            },
            response_format: {
              type: "string",
              enum: ["url", "b64_json"],
              default: "b64_json",
              description:
                "Images are returned inline as data URLs; `url` returns that data URL in the `url` field.",
            },
          },
        },
        ImageResponse: {
          type: "object",
          properties: {
            created: { type: "integer" },
            data: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  b64_json: { type: "string" },
                  url: { type: "string" },
                },
              },
            },
          },
        },
        OcrRequest: {
          type: "object",
          required: ["document"],
          additionalProperties: true,
          properties: {
            model: {
              type: "string",
              description: "Defaults to the Mistral OCR model.",
            },
            document: {
              description:
                "The document to read. HTTPS URLs and base64 data URLs are accepted.",
              oneOf: [
                {
                  type: "object",
                  required: ["type", "image_url"],
                  properties: {
                    type: { type: "string", const: "image_url" },
                    image_url: { type: "string" },
                  },
                },
                {
                  type: "object",
                  required: ["type", "document_url"],
                  properties: {
                    type: { type: "string", const: "document_url" },
                    document_url: { type: "string" },
                  },
                },
                {
                  type: "object",
                  required: ["type", "file_id"],
                  properties: {
                    type: { type: "string", const: "file" },
                    file_id: { type: "string" },
                  },
                },
              ],
            },
            pages: { type: "array", items: { type: "integer" } },
            include_image_base64: { type: "boolean" },
            table_format: { type: "string", enum: ["markdown", "html"] },
          },
        },
        Usage: {
          type: "object",
          additionalProperties: true,
          properties: {
            prompt_tokens: { type: "integer" },
            completion_tokens: { type: "integer" },
            total_tokens: { type: "integer" },
            cost: {
              type: "number",
              description:
                "Cost of the request in USD, billed against your daily limit.",
            },
          },
        },
        Stats: {
          type: "object",
          required: [
            "totalRequests",
            "totalTokens",
            "totalPromptTokens",
            "totalCompletionTokens",
          ],
          properties: {
            totalRequests: { type: "integer" },
            totalTokens: { type: "integer" },
            totalPromptTokens: { type: "integer" },
            totalCompletionTokens: { type: "integer" },
          },
        },
        HealthUp: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", const: "up" },
            balanceRemaining: { type: "number" },
            dailyKeyUsageRemaining: { type: "number" },
            replicateUnusedCredit: { type: "number" },
            timestamp: { type: "integer" },
          },
        },
        HealthDown: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", const: "down" },
            timestamp: { type: "integer" },
          },
        },
      },
    },
  };
};
