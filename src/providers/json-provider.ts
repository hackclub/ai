import type { Fetch } from "./openrouter/adapter";
import type { Usd } from "../billing/money";
import { forwardableHeaders } from "./response-headers";
import type { MeteredProviderResponse, ProviderCompletion } from "./types";

export type JsonProviderOptions = {
  url: string;
  init: RequestInit & { body: string };
  fetch?: Fetch;
  /** Provider-reported cost for a successful response, or null when absent. */
  extractCost: (body: unknown) => Usd | null;
  extractProviderRequestId?: (body: unknown) => string | null;
  extractTokens?: (body: unknown) => { inputTokens: number; outputTokens: number } | null;
  /**
   * Replaces the body stored for analytics. The client still receives the
   * full upstream body. Used for OCR, whose page text must not be logged.
   */
  redactResponseBody?: (body: unknown, raw: string) => string;
};

/**
 * Executes a request-response (non-streaming) JSON provider call and derives
 * the billing outcome from the buffered body. The response returned to the
 * caller carries the upstream status, headers, and bytes unchanged.
 */
export async function executeJsonProvider(
  options: JsonProviderOptions,
): Promise<MeteredProviderResponse> {
  const fetchImplementation = options.fetch ?? fetch;
  const upstream = await fetchImplementation(options.url, options.init);
  return meterJsonResponse(upstream, options);
}

/** Buffers a JSON provider response and derives its billing outcome. */
export async function meterJsonResponse(
  upstream: Response,
  options: Pick<
    JsonProviderOptions,
    "init" | "extractCost" | "extractProviderRequestId" | "extractTokens" | "redactResponseBody"
  >,
): Promise<MeteredProviderResponse> {
  const raw = await upstream.text();

  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parseFailed = true;
  }

  const providerRequestId =
    parseFailed ? null : (options.extractProviderRequestId?.(parsed) ?? null);
  const analyticsBody =
    parseFailed || !options.redactResponseBody
      ? raw
      : options.redactResponseBody(parsed, raw);

  let completion: ProviderCompletion;
  const success = upstream.status >= 200 && upstream.status < 300;
  const cost = success && !parseFailed ? options.extractCost(parsed) : null;
  if (!success) {
    completion = {
      state: "uncertain",
      providerRequestId,
      reason: `Provider responded with HTTP ${upstream.status}`,
      responseBody: analyticsBody,
      bodyCapture: "complete",
    };
  } else if (parseFailed) {
    completion = {
      state: "uncertain",
      providerRequestId,
      reason: "Provider returned a non-JSON response",
      responseBody: analyticsBody,
      bodyCapture: "complete",
    };
  } else if (!cost) {
    completion = {
      state: "uncertain",
      providerRequestId,
      reason: "Provider response did not report a cost",
      responseBody: analyticsBody,
      bodyCapture: "complete",
    };
  } else {
    const tokens = options.extractTokens?.(parsed) ?? { inputTokens: 0, outputTokens: 0 };
    completion = {
      state: "complete",
      providerRequestId,
      usage: {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        totalTokens: tokens.inputTokens + tokens.outputTokens,
        costUsd: cost,
      },
      responseBody: analyticsBody,
      bodyCapture: "complete",
    };
  }

  const headers = forwardableHeaders(upstream.headers);

  return {
    response: new Response(raw, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }),
    requestBody: options.init.body,
    completion: Promise.resolve(completion),
  };
}
