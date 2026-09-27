import { Elysia } from "elysia";
import type postgres from "postgres";

import type { UsageStats } from "../analytics/queries";
import type { BillingLifecycle, SettlementTracker } from "./metered-request";
import { Usd } from "../billing/money";
import { estimateLanguageReservation } from "../billing/estimate-language-reservation";
import { type ModelCatalog, type ModelKind, modelPricing } from "../models/catalog";
import { isEventStream } from "../providers/metered-body";
import type { OpenRouterAdapter } from "../providers/openrouter/adapter";
import { OPENROUTER } from "../providers/openrouter/provider";
import { forwardableHeaders } from "../providers/response-headers";
import { HttpError } from "./http-error";
import { jsonWithEtag } from "./etag";
import { RateLimiter } from "./rate-limit";
import { authorizeProviderRequest, parseJsonObject, runProviderRoute } from "./routes/shared";

export type ProxyDependencies = {
  sql: postgres.Sql;
  billing: BillingLifecycle;
  /** Settlements still in flight; the backend drains it on shutdown. */
  settlements: SettlementTracker;
  catalog: ModelCatalog;
  /** Lifetime usage for `GET /proxy/v1/stats`. */
  usageStats: (accountId: string) => Promise<UsageStats>;
  adapter: OpenRouterAdapter;
  openRouterApiKey: string;
  enforceIdv: boolean;
  reservationFallbackOutputTokens: number;
  /**
   * Hold placed when OpenRouter's listing has no usable pricing for the
   * requested model (dynamically priced, or the listing is unavailable). The real cost replaces
   * it on finalization. Defaults to 0.05 USD.
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

/**
 * Cloudflare closes idle responses after about 100 seconds. A non-streaming
 * completion can take longer to produce its single JSON chunk, so emit a
 * space (valid leading whitespace for JSON) until the first upstream byte.
 * The adapter captured the upstream body before this wrapper, so analytics
 * and billing see the unpadded response.
 */
export const withKeepAlive = (response: Response, intervalMs: number) => {
  if (!response.body || isEventStream(response.headers) || intervalMs <= 0) {
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

const positiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

/**
 * The output cap upstream applies. Responses reads only `max_output_tokens`;
 * Chat Completions takes either field, so the larger one counts. Zero is no
 * cap.
 */
const requestedMaxOutputTokens = (endpoint: ProxyEndpoint, body: Record<string, unknown>) => {
  const fields = endpoint === "responses" ? [body.max_output_tokens] : [body.max_tokens, body.max_completion_tokens];
  const caps = fields.map(positiveInteger).filter((cap) => cap !== undefined);
  return caps.length > 0 ? Math.max(...caps) : undefined;
};

/** `model`, then the `models` OpenRouter falls back to when it fails. */
const requestedModelIds = (body: { model: string; models?: unknown }) => {
  if (body.models === undefined || body.models === null) return [body.model];
  if (!Array.isArray(body.models) || !body.models.every((id): id is string => typeof id === "string" && id.length > 0)) {
    throw new HttpError(400, "models must be an array of model IDs");
  }
  return [body.model, ...body.models];
};

/**
 * Work OpenRouter bills on top of the model and the listing does not price:
 * the `:online` variant, plugins (web search, PDF parsing),
 * `web_search_options`, and server-side tools such as web search.
 */
const requestsUnpricedExtras = (ids: string[], body: Record<string, unknown>) =>
  ids.some((id) => id.endsWith(":online")) ||
  (Array.isArray(body.plugins) && body.plugins.length > 0) ||
  (body.web_search_options !== undefined && body.web_search_options !== null) ||
  (Array.isArray(body.tools) &&
    body.tools.some(
      (tool) => tool !== null && typeof tool === "object" && "type" in tool && tool.type !== "function",
    ));

/** Upper bound on OpenAI's `n`; the hold scales linearly with it. */
const MAX_COMPLETIONS = 8;

/** Completions the request asks for; 400 unless `n` is an integer in 1..8. */
const requestedCompletions = (body: Record<string, unknown>) => {
  if (body.n === undefined || body.n === null) return 1;
  if (
    typeof body.n !== "number" ||
    !Number.isSafeInteger(body.n) ||
    body.n < 1 ||
    body.n > MAX_COMPLETIONS
  ) {
    throw new HttpError(400, `n must be an integer from 1 to ${MAX_COMPLETIONS}`);
  }
  return body.n;
};

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
    endpoint: ProxyEndpoint,
    model: Parameters<typeof modelPricing>[0] | null,
    body: Record<string, unknown>,
  ) => {
    const kind = ENDPOINTS[endpoint];
    const completions = kind === "embedding" ? 1 : requestedCompletions(body);
    const pricing = model ? modelPricing(model) : null;
    if (!pricing) return unknownModelReservation.multiply(BigInt(completions));

    // System instructions and tool schemas are prompt tokens too; leaving
    // them out under-reserves tool-heavy requests.
    const billableFields = BILLABLE_INPUT_FIELDS.filter((field) => body[field] !== undefined);
    const billable =
      billableFields.length > 0
        ? Object.fromEntries(billableFields.map((field) => [field, body[field]]))
        : body;
    const modelMaxOutputTokens =
      kind === "embedding"
        ? 0
        : (pricing.maxCompletionTokens ?? deps.reservationFallbackOutputTokens);

    return estimateLanguageReservation({
      serializedBillableInput: JSON.stringify(billable),
      inputTokenPriceUsd: pricing.promptUsd.toString(),
      outputTokenPriceUsd: pricing.completionUsd.toString(),
      requestedMaxOutputTokens:
        kind === "embedding" ? 0 : requestedMaxOutputTokens(endpoint, body),
      modelMaxOutputTokens,
      completions,
      fixedCostUsd: pricing.requestUsd.toString(),
    }).amountUsd;
  };

  const handle = async (endpoint: ProxyEndpoint, request: Request) => {
    const kind = ENDPOINTS[endpoint];
    const rawBody = await request.text();
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody);

    const body = parseBody(rawBody);
    // Unknown ids are refused before anything is reserved or recorded. When
    // the listing itself is unavailable, OpenRouter decides.
    const ids = requestedModelIds(body);
    const models = await Promise.all(ids.map((id) => deps.catalog.find(kind, id).catch(() => undefined)));
    const unlisted = ids.find((_, index) => models[index] === null);
    if (unlisted !== undefined) throw new HttpError(400, `${unlisted} is not a valid model ID`);

    // Attribution for abuse handling and authoritative usage in streams. No
    // sampling parameter is touched; see the architecture doc.
    body.user = `user_${principal.userId}`;
    body.usage = { include: true };

    // Priced as the dearest model it may run, since any fallback can serve it.
    const priciest = models
      .map((model) => estimateFor(endpoint, model ?? null, body))
      .reduce((max, estimate) => (max.lessThan(estimate) ? estimate : max));
    const estimate = requestsUnpricedExtras(ids, body) ? priciest.add(unknownModelReservation) : priciest;

    const { metered, requestId } = await runProviderRoute(
      deps,
      request,
      principal,
      {
        provider: OPENROUTER,
        endpoint,
        model: body.model,
        estimatedCostUsd: estimate,
        reservationTtlMs,
        // Request shape, for the behavioural abuse scan that reads metadata only.
        attributes: {
          tool_count: String(Array.isArray(body.tools) ? body.tools.length : 0),
          message_count: String(
            Array.isArray(body.messages) ? body.messages.length : Array.isArray(body.input) ? body.input.length : 1,
          ),
        },
        execute: () =>
          deps.adapter.execute({
            endpoint,
            body,
            apiKey: deps.openRouterApiKey,
            headers: deps.attributionHeaders,
          }),
      },
      { rewrapResponse: false },
    );

    const headers = forwardableHeaders(metered.response.headers);
    headers.set("x-request-id", requestId);
    const response = withKeepAlive(
      new Response(metered.response.body, {
        status: metered.response.status,
        statusText: metered.response.statusText,
        headers,
      }),
      keepAliveMs,
    );
    // The upstream call takes no abort signal, so the generation id always
    // arrives. A client that has left is cancelled here instead: OpenRouter
    // stops the generation, and reconciliation bills what it produced. Bun
    // does not cancel a body it never started sending.
    const abandon = () => void response.body?.cancel("client disconnected").catch(() => {});
    if (request.signal.aborted) abandon();
    else request.signal.addEventListener("abort", abandon, { once: true });
    return response;
  };

  return new Elysia({ prefix: "/proxy/v1" })
    .error(({ error }) => {
      if (error instanceof HttpError) return error.toResponse();
      return undefined;
    })
    .get("/models", async ({ request }) => {
      const [language, embedding] = await Promise.all([
        deps.catalog.list("language"),
        deps.catalog.list("embedding"),
      ]);
      return jsonWithEtag(request, { data: [...language, ...embedding] });
    })
    .get("/embeddings/models", async ({ request }) =>
      jsonWithEtag(request, { data: await deps.catalog.list("embedding") }),
    )
    .get("/stats", async ({ request }) => {
      const principal = await authorizeProviderRequest(deps, rateLimiter, request, "");
      return Response.json(await deps.usageStats(principal.billingAccountId));
    })
    .post("/chat/completions", ({ request }) =>
      handle("chat/completions", request),
    )
    .post("/responses", ({ request }) => handle("responses", request))
    .post("/embeddings", ({ request }) => handle("embeddings", request));
};
