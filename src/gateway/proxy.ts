import { Elysia } from "elysia";
import type postgres from "postgres";

import type { BillingEngine } from "../billing/engine";
import { Usd } from "../billing/money";
import { estimateLanguageReservation } from "../billing/estimate-language-reservation";
import { type ModelCatalog, type ModelKind, modelPricing } from "../models/catalog";
import type { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { forwardableHeaders } from "../providers/response-headers";
import { HttpError } from "./http-error";
import { RateLimiter } from "./rate-limit";
import { authorizeProviderRequest, parseJsonObject, runProviderRoute } from "./routes/shared";

export type ProxyDependencies = {
  sql: postgres.Sql;
  billing: BillingEngine;
  catalog: ModelCatalog;
  adapter: OpenRouterAdapter;
  openRouterApiKey: string;
  enforceIdv: boolean;
  reservationFallbackOutputTokens: number;
  /**
   * Hold placed when OpenRouter's listing has no usable pricing for the
   * requested model (unlisted or dynamically priced). The real cost replaces
   * it on finalization. Defaults to 0.05 USD, as in the previous gateway.
   */
  unknownModelReservationUsd?: string;
  /** Attribution headers OpenRouter shows in its app rankings. */
  attributionHeaders?: Record<string, string>;
  onSettlementError?: (error: unknown, requestId: string) => void;
  /** Per-user request limiter; defaults to 7500 per 30 minutes. */
  rateLimiter?: RateLimiter;
  /** Interval for whitespace keep-alives on non-streaming responses. */
  keepAliveMs?: number;
  /**
   * How long a reservation stays held before the expiry sweeper may release
   * it. Must outlast the longest response the gateway will stream: a
   * reservation released mid-flight is finalized without its holds.
   * Defaults to 60 minutes.
   */
  reservationTtlMs?: number;
};

/** Request fields that count toward the prompt and so toward the estimate. */
const BILLABLE_INPUT_FIELDS = [
  "messages",
  "input",
  "prompt",
  "instructions",
  "system",
  "tools",
  "functions",
] as const;

const isEventStream = (response: Response) =>
  response.headers.get("content-type")?.includes("text/event-stream") ?? false;

/**
 * Cloudflare closes idle responses after about 100 seconds. A non-streaming
 * completion can take longer to produce its single JSON chunk, so emit a
 * space (valid leading whitespace for JSON) until the first upstream byte.
 * The adapter captured the upstream body before this wrapper, so analytics
 * and billing see the unpadded response.
 */
export const withKeepAlive = (response: Response, intervalMs: number) => {
  if (!response.body || isEventStream(response) || intervalMs <= 0) {
    return response;
  }
  const reader = response.body.getReader();
  const space = new TextEncoder().encode(" ");
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let firstByte = false;
      const timer = setInterval(() => {
        if (!firstByte && !finished) controller.enqueue(space);
      }, intervalMs);
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          firstByte = true;
          if (!finished) controller.enqueue(next.value);
        }
        if (!finished) controller.close();
      } catch (error) {
        if (!finished) controller.error(error);
      } finally {
        finished = true;
        clearInterval(timer);
      }
    },
    cancel(reason) {
      // The body is locked to `reader` above, so cancelling the stream itself
      // would throw and leave the upstream (and its billing) running.
      finished = true;
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

type ProxyEndpoint = "chat/completions" | "responses" | "embeddings";

const ENDPOINTS: Record<ProxyEndpoint, ModelKind> = {
  "chat/completions": "language",
  responses: "language",
  embeddings: "embedding",
};

const optionalInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const parseBody = (raw: string) => {
  const record = parseJsonObject(raw);
  if (typeof record.model !== "string" || record.model.length === 0) {
    throw new HttpError(400, "A model must be specified");
  }
  return record as Record<string, unknown> & { model: string };
};

/**
 * The OpenAI-compatible proxy: `/proxy/v1/{chat/completions,responses,
 * embeddings}` plus the unauthenticated model listing. The upstream response
 * is returned unchanged; billing settles after the client finishes reading.
 */
export const proxyRoutes = (deps: ProxyDependencies) => {
  const rateLimiter =
    deps.rateLimiter ?? new RateLimiter({ limit: 7_500, windowMs: 30 * 60 * 1_000 });
  const keepAliveMs = deps.keepAliveMs ?? 10_000;
  const reservationTtlMs = deps.reservationTtlMs ?? 60 * 60 * 1_000;
  const unknownModelReservation = Usd.parse(deps.unknownModelReservationUsd ?? "0.05");

  const estimateFor = (
    kind: ModelKind,
    model: Parameters<typeof modelPricing>[0] | null,
    body: Record<string, unknown>,
  ) => {
    const pricing = model ? modelPricing(model) : null;
    if (!pricing) return unknownModelReservation;

    // System instructions and tool schemas are prompt tokens too; leaving
    // them out under-reserves tool-heavy requests.
    const billableFields = BILLABLE_INPUT_FIELDS.filter((field) => body[field] !== undefined);
    const billable =
      billableFields.length > 0
        ? Object.fromEntries(billableFields.map((field) => [field, body[field]]))
        : body;
    const requestedMaxOutputTokens =
      optionalInteger(body.max_tokens) ??
      optionalInteger(body.max_completion_tokens) ??
      optionalInteger(body.max_output_tokens);
    const modelMaxOutputTokens =
      kind === "embedding"
        ? 0
        : (pricing.maxCompletionTokens ?? deps.reservationFallbackOutputTokens);

    return estimateLanguageReservation({
      serializedBillableInput: JSON.stringify(billable),
      inputTokenPriceUsd: pricing.promptUsd.toString(),
      outputTokenPriceUsd: pricing.completionUsd.toString(),
      requestedMaxOutputTokens:
        kind === "embedding" ? 0 : requestedMaxOutputTokens,
      modelMaxOutputTokens,
      fixedCostUsd: pricing.requestUsd.toString(),
    }).amountUsd;
  };

  const handle = async (endpoint: ProxyEndpoint, request: Request) => {
    const kind = ENDPOINTS[endpoint];
    const rawBody = await request.text();
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody);

    const body = parseBody(rawBody);
    // Any model OpenRouter serves is allowed; the listing is only consulted
    // for the reservation estimate. OpenRouter rejects ids it does not know.
    const model = await deps.catalog.find(kind, body.model).catch(() => null);

    // Attribution for abuse handling and authoritative usage in streams. No
    // sampling parameter is touched; see the architecture doc.
    body.user = `user_${principal.userId}`;
    body.usage = { include: true };

    const { metered, requestId } = await runProviderRoute(
      deps,
      request,
      principal,
      {
        provider: "openrouter",
        endpoint,
        model: body.model,
        estimatedCostUsd: estimateFor(kind, model, body),
        reservationTtlMs,
        execute: () =>
          deps.adapter.execute({
            endpoint,
            body,
            apiKey: deps.openRouterApiKey,
            headers: deps.attributionHeaders,
            signal: request.signal,
          }),
      },
      { rewrapResponse: false },
    );

    const headers = forwardableHeaders(metered.response.headers);
    headers.set("x-request-id", requestId);
    return withKeepAlive(
      new Response(metered.response.body, {
        status: metered.response.status,
        statusText: metered.response.statusText,
        headers,
      }),
      keepAliveMs,
    );
  };

  return new Elysia({ prefix: "/proxy/v1" })
    .error(({ error }) => {
      if (error instanceof HttpError) return error.toResponse();
      return undefined;
    })
    .get("/models", async () => {
      const [language, embedding] = await Promise.all([
        deps.catalog.list("language"),
        deps.catalog.list("embedding"),
      ]);
      return { data: [...language, ...embedding] };
    })
    .post("/chat/completions", ({ request }) =>
      handle("chat/completions", request),
    )
    .post("/responses", ({ request }) => handle("responses", request))
    .post("/embeddings", ({ request }) => handle("embeddings", request));
};
