import {
  type ProviderCompletion,
  type MeteredProviderResponse,
  type NormalizedUsage,
} from "../types";
import { ServerSentEventParser } from "../sse-parser";
import { openRouterRequestId, openRouterUsage } from "./usage";

export type OpenRouterRequest = {
  endpoint: string;
  body: Record<string, unknown>;
  apiKey: string;
  signal?: AbortSignal;
  headers?: HeadersInit;
};

export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenRouterAdapterOptions = {
  baseUrl?: string;
  fetch?: Fetch;
  maxCapturedBytes?: number;
  /** Total attempts for a transient refusal; defaults to 3. */
  maxAttempts?: number;
  /** Injectable for tests; resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Largest response body kept for analytics/search. Streamed bodies past this
 * cap are truncated for storage only; the client still receives every byte
 * and the SSE observer still sees every chunk for usage parsing.
 */
export const MAX_CAPTURED_RESPONSE_BYTES = 1024 * 1024;

type ObservedUsage = {
  requestId: string | null;
  usage: NormalizedUsage | null;
  providerError: string | null;
};

const responseText = (chunks: Uint8Array[]) => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

const providerError = (value: unknown): string | null => {
  if (value === null || typeof value !== "object") return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error === null || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : "OpenRouter provider error";
};

class OpenRouterResponseObserver {
  private requestId: string | null;
  private usage: NormalizedUsage | null = null;
  private error: string | null = null;
  private readonly parser: ServerSentEventParser | null;

  /**
   * `headerRequestId` comes from `X-Generation-Id`, so a request cancelled
   * before any body arrives can still be reconciled; body ids override it.
   */
  constructor(
    readonly eventStream: boolean,
    headerRequestId: string | null,
  ) {
    this.requestId = headerRequestId;
    this.parser = eventStream
      ? new ServerSentEventParser(({ data }) => {
          if (data === "[DONE]") return;
          try {
            this.observeValue(JSON.parse(data));
          } catch {
            // Invalid provider events are preserved byte-for-byte for the
            // caller and body search, but cannot be treated as billing facts.
          }
        })
      : null;
  }

  push(chunk: Uint8Array) {
    this.parser?.push(chunk);
  }

  finish(body: string): ObservedUsage {
    if (this.parser) {
      this.parser.finish();
    } else {
      try {
        this.observeValue(JSON.parse(body));
      } catch {
        this.error = "OpenRouter returned a non-JSON response";
      }
    }

    return {
      requestId: this.requestId,
      usage: this.usage,
      providerError: this.error,
    };
  }

  private observeValue(value: unknown) {
    this.requestId = openRouterRequestId(value) ?? this.requestId;
    this.usage = openRouterUsage(value) ?? this.usage;
    this.error = providerError(value) ?? this.error;
  }
}

const uncertainCompletion = (
  observation: ObservedUsage,
  body: string,
  bodyCapture: "complete" | "partial" | "truncated",
  reason?: string,
): ProviderCompletion => ({
  state: "uncertain",
  providerRequestId: observation.requestId,
  reason:
    reason ??
    observation.providerError ??
    "OpenRouter response ended without authoritative cost",
  responseBody: body,
  bodyCapture,
});

/**
 * OpenRouter reports usage only once generation has finished (the last
 * stream event, or the whole JSON body), so usage seen before a cancel or a
 * stream error is final and can be billed instead of reconciled later.
 */
const completeIfUsageSeen = (
  observation: ObservedUsage,
  body: string,
  truncated: boolean,
): ProviderCompletion | null =>
  observation.usage
    ? {
        state: "complete",
        providerRequestId: observation.requestId,
        usage: observation.usage,
        responseBody: body,
        bodyCapture: truncated ? "truncated" : "complete",
      }
    : null;

const meterResponse = (
  upstream: Response,
  requestBody: string,
  maxCapturedBytes: number,
): MeteredProviderResponse => {
  let settle: (completion: ProviderCompletion) => void = () => {};
  const completion = new Promise<ProviderCompletion>((resolve) => {
    settle = resolve;
  });
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const observer = new OpenRouterResponseObserver(
    upstream.headers.get("content-type")?.includes("text/event-stream") ??
      false,
    upstream.headers.get("x-generation-id") || null,
  );

  if (!upstream.body) {
    const observation = observer.finish("");
    settle(uncertainCompletion(observation, "", "complete", "Empty response"));
    return { response: upstream, requestBody, completion };
  }

  const reader = upstream.body.getReader();
  let cancelled = false;
  let settled = false;
  const settleOnce = (result: ProviderCompletion) => {
    if (settled) return;
    settled = true;
    settle(result);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        // A pull may already be awaiting the upstream reader when the client
        // cancels. Its result must neither reach the closed controller nor
        // override the cancellation outcome.
        if (cancelled) return;
        if (!next.done) {
          const copy = next.value.slice();
          observer.push(copy);
          // Non-streaming bodies are parsed whole for usage; they are
          // bounded by the provider's single JSON document, so only event
          // streams are capped here.
          if (
            !observer.eventStream ||
            (!truncated && capturedBytes + copy.byteLength <= maxCapturedBytes)
          ) {
            chunks.push(copy);
            capturedBytes += copy.byteLength;
          } else {
            truncated = true;
          }
          controller.enqueue(next.value);
          return;
        }

        const captured = responseText(chunks);
        const observation = observer.finish(captured);
        if (observation.usage) {
          settleOnce({
            state: "complete",
            providerRequestId: observation.requestId,
            usage: observation.usage,
            responseBody: captured,
            bodyCapture: truncated ? "truncated" : "complete",
          });
        } else {
          settleOnce(
            uncertainCompletion(
              observation,
              captured,
              truncated ? "truncated" : "complete",
            ),
          );
        }
        controller.close();
      } catch (error) {
        if (cancelled) return;
        const captured = responseText(chunks);
        const observation = observer.finish(captured);
        settleOnce(
          completeIfUsageSeen(observation, captured, truncated) ??
            uncertainCompletion(
              observation,
              captured,
              truncated ? "truncated" : "partial",
              error instanceof Error ? error.message : "Response stream failed",
            ),
        );
        controller.error(error);
      }
    },

    async cancel(reason) {
      cancelled = true;
      // The upstream may already be gone (aborted fetch, closed socket). A
      // rejected cancel must not leave `completion` unsettled, or the
      // reservation would only ever close by expiry.
      await reader.cancel(reason).catch(() => {});
      const captured = responseText(chunks);
      const observation = observer.finish(captured);
      settleOnce(completeIfUsageSeen(observation, captured, truncated) ?? {
        state: "cancelled",
        providerRequestId: observation.requestId,
        reason: typeof reason === "string" ? reason : "Client cancelled stream",
        responseBody: captured,
        bodyCapture: truncated ? "truncated" : "partial",
      });
    },
  });

  return {
    response: new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    }),
    requestBody,
    completion,
  };
};

/** Longest upstream Retry-After we wait out; beyond it the refusal is returned. */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Delay before retrying a transient refusal, or null to return it as-is.
 * Only refusals sent before any provider accepted the request are retried:
 * 429 and 502/503, and a 402 that OpenRouter marks as its transient
 * in-flight budget. Timeouts and 504s are not, because the first attempt may
 * still be generating (and billed) with no generation id to reconcile.
 */
const retryDelayMs = async (response: Response, attempt: number): Promise<number | null> => {
  const { status } = response;
  if (status === 402) {
    const body = await response.clone().text().catch(() => "");
    if (!body.includes("openrouter_in_flight_budget")) return null;
  } else if (status !== 429 && status !== 502 && status !== 503) {
    return null;
  }
  const retryAfter = retryAfterMs(response.headers.get("retry-after"));
  if (retryAfter !== null) return retryAfter <= MAX_RETRY_AFTER_MS ? retryAfter : null;
  // 0.5s, 1s, 2s... capped at 8s, with up to 25% jitter (as the OpenAI SDKs).
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base * (1 - Math.random() * 0.25);
};

const retryAfterMs = (header: string | null): number | null => {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

export class OpenRouterAdapter {
  private readonly baseUrl: string;
  private readonly fetchImplementation: Fetch;
  private readonly maxCapturedBytes: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OpenRouterAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api").replace(
      /\/$/,
      "",
    );
    this.fetchImplementation = options.fetch ?? fetch;
    this.maxCapturedBytes =
      options.maxCapturedBytes ?? MAX_CAPTURED_RESPONSE_BYTES;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  async execute(request: OpenRouterRequest): Promise<MeteredProviderResponse> {
    const requestBody = JSON.stringify(request.body);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${request.apiKey}`);
    headers.set("content-type", "application/json");

    const url = `${this.baseUrl}/v1/${request.endpoint.replace(/^\//, "")}`;
    // Every attempt runs under the caller's single reservation. Retries
    // happen before the response reaches the client, so none is ever
    // retried after bytes were sent.
    for (let attempt = 0; ; attempt += 1) {
      const upstream = await this.fetchImplementation(url, {
        method: "POST",
        headers,
        body: requestBody,
        signal: request.signal,
      });
      const delay =
        attempt + 1 < this.maxAttempts ? await retryDelayMs(upstream, attempt) : null;
      if (delay === null || request.signal?.aborted) {
        return meterResponse(upstream, requestBody, this.maxCapturedBytes);
      }
      await upstream.body?.cancel().catch(() => {});
      await this.sleep(delay);
    }
  }
}
