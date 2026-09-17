import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import type { OpenRouterAdapter } from "../../providers/openrouter/adapter";
import { HttpError } from "../http-error";
import { runMeteredRequest } from "../metered-request";
import {
  authorizeProviderRequest,
  billingErrorToHttp,
  clientIp,
  defaultRateLimiter,
  type MeteredRouteDependencies,
  parseJsonObject,
} from "./shared";

export type ImagesRouteDependencies = MeteredRouteDependencies & {
  adapter: OpenRouterAdapter;
  openRouterApiKey: string;
  allowedImageModels: string[];
  attributionHeaders?: Record<string, string>;
  /** Fixed hold; the real cost replaces it on finalization. */
  reservationUsd?: string;
};

export const SIZE_RATIOS: Record<string, string> = {
  "1024x1024": "1:1",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
  "512x512": "1:1",
  "256x256": "1:1",
};

export type ImageGenerationRequest = {
  prompt: string;
  model: string;
  size?: string;
  response_format?: "url" | "b64_json";
};

/** Translates the OpenAI images request into an OpenRouter chat completion. */
export const buildImageChatRequest = (input: ImageGenerationRequest, userId: string) => ({
  model: input.model,
  messages: [{ role: "user", content: input.prompt }],
  modalities: ["image", "text"],
  image_config: { aspect_ratio: SIZE_RATIOS[input.size ?? ""] ?? "1:1" },
  user: `user_${userId}`,
  usage: { include: true },
});

type ChatImageResponse = {
  choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
};

/** Extracts data URLs from the chat response in the OpenAI images shape. */
export type GeneratedImage = { url: string } | { b64_json: string };

export const imagesFromChatResponse = (
  data: ChatImageResponse,
  responseFormat: "url" | "b64_json" | undefined,
): GeneratedImage[] =>
  (data.choices ?? []).flatMap((choice) =>
    (choice.message?.images ?? []).flatMap((image): GeneratedImage[] => {
      const url = image.image_url?.url;
      if (!url?.startsWith("data:")) return [];
      return responseFormat === "url" ? [{ url }] : [{ b64_json: url.split(",")[1] ?? "" }];
    }),
  );

export const parseImageGenerationRequest = (
  body: Record<string, unknown>,
  allowedImageModels: string[],
): ImageGenerationRequest => {
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    throw new HttpError(400, "A prompt is required");
  }
  const model = typeof body.model === "string" && body.model.length > 0
    ? body.model
    : allowedImageModels[0];
  if (!model) throw new HttpError(400, "No image model is available");
  if (!allowedImageModels.includes(model)) throw new HttpError(400, `Unknown model: ${model}`);
  const responseFormat =
    body.response_format === "url" || body.response_format === "b64_json"
      ? body.response_format
      : undefined;
  return {
    prompt: body.prompt,
    model,
    size: typeof body.size === "string" ? body.size : undefined,
    response_format: responseFormat,
  };
};

/** `POST /proxy/v1/images/generations` over OpenRouter image-capable chat models. */
export const imagesRoutes = (deps: ImagesRouteDependencies) => {
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter();
  const reservation = Usd.parse(deps.reservationUsd ?? "0.25");

  return new Elysia({ prefix: "/proxy/v1" }).post("/images/generations", async ({ request }) => {
    const rawBody = await request.text();
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody);
    const input = parseImageGenerationRequest(parseJsonObject(rawBody), deps.allowedImageModels);
    const chatBody = buildImageChatRequest(input, principal.userId);
    const requestId = crypto.randomUUID();

    let metered;
    try {
      metered = await runMeteredRequest(deps.billing, {
        requestId,
        accountId: principal.billingAccountId,
        provider: "openrouter",
        endpoint: "images/generations",
        model: input.model,
        estimatedCostUsd: reservation,
        analytics: {
          userId: principal.userId,
          apiKeyId: principal.apiKeyId,
          requestHeaders: request.headers,
          attributes: { ip: clientIp(request.headers) },
        },
        execute: () =>
          deps.adapter.execute({
            endpoint: "chat/completions",
            body: chatBody,
            apiKey: deps.openRouterApiKey,
            headers: deps.attributionHeaders,
            signal: request.signal,
          }),
      });
    } catch (error) {
      throw billingErrorToHttp(error) ?? error;
    }
    metered.settled.catch((error) => deps.onSettlementError?.(error, requestId));

    // Reading the body settles billing through the adapter's capture.
    const text = await metered.response.text();
    let data: ChatImageResponse;
    try {
      data = JSON.parse(text) as ChatImageResponse;
    } catch {
      throw new HttpError(502, "Invalid response from image provider");
    }
    if (!metered.response.ok) {
      return new Response(text, {
        status: metered.response.status,
        headers: { "content-type": "application/json" },
      });
    }
    return {
      created: Math.floor(Date.now() / 1_000),
      data: imagesFromChatResponse(data, input.response_format),
    };
  });
};
