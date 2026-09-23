import {
  type CapturedBody,
  isEventStream,
  meterStreamed,
  type UsageReader,
  type UsageVerdict,
} from "../metered-body";
import type { MeteredProviderResponse, NormalizedUsage } from "../types";
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

const providerError = (value: unknown): string | null => {
  if (value === null || typeof value !== "object") return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error === null || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : "OpenRouter provider error";
};

const GATEWAY_TIMEOUT_REASON = "OpenRouter gateway timeout; generation may still be running";

/**
 * Reads OpenRouter usage from a response: event streams are parsed as they
 * arrive, a JSON body is parsed whole at the end. OpenRouter reports usage
 * only once generation has finished (the last stream event, or the whole
 * JSON body), so usage seen before a cancel or a stream error is final and
 * is billed instead of reconciled later.
 */
class OpenRouterResponseReader implements UsageReader {
  private requestId: string | null;
  private usage: NormalizedUsage | null = null;
  private error: string | null = null;
  private readonly parser: ServerSentEventParser | null;
  private readonly hasBody: boolean;

  /**
   * The id is seeded from `X-Generation-Id`, so a request cancelled before
   * any body arrives can still be reconciled; body ids override it.
   */
  constructor(upstream: Response) {
    this.requestId = upstream.headers.get("x-generation-id") || null;
    this.hasBody = upstream.body !== null;
    this.parser = isEventStream(upstream.headers)
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

  observe = (chunk: Uint8Array) => {
    this.parser?.push(chunk);
  };

  read = (body: CapturedBody): UsageVerdict => {
    const observed = this.finish(body.text);
    if (observed.usage) {
      return { usage: observed.usage, providerRequestId: observed.requestId };
    }
    return {
      usage: null,
      providerRequestId: observed.requestId,
      reason: this.reason(body, observed),
      // A 504 may come back while the generation is still running (and
      // billed), so the reconciler must look it up rather than close it free.
      mayStillBeCharged: body.status === 504,
    };
  };

  private reason(body: CapturedBody, observed: ObservedUsage): string {
    const { end } = body;
    switch (end.kind) {
      case "error":
        return end.error instanceof Error ? end.error.message : "Response stream failed";
      case "cancelled":
        return typeof end.reason === "string" ? end.reason : "Client cancelled stream";
      case "done":
        if (body.status === 504) return GATEWAY_TIMEOUT_REASON;
        if (!this.hasBody) return "Empty response";
        return observed.providerError ?? "OpenRouter response ended without authoritative cost";
    }
  }

  private finish(body: string): ObservedUsage {
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
        return meterStreamed(upstream, {
          requestBody,
          reader: new OpenRouterResponseReader(upstream),
          // A JSON body is one document parsed whole for usage, bounded by
          // the provider; only event streams are capped for storage.
          maxCapturedBytes: isEventStream(upstream.headers) ? this.maxCapturedBytes : null,
          headers: "upstream",
          onCancel: { kind: "cancel-upstream" },
        });
      }
      await upstream.body?.cancel().catch(() => {});
      await this.sleep(delay);
    }
  }
}
