import type { Fetch } from "./openrouter/adapter";
import type { Usd } from "../billing/money";
import { type CapturedBody, meterBuffered, type UsageVerdict } from "./metered-body";
import type { MeteredProviderResponse } from "./types";

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

type JsonReadOptions = Pick<
  JsonProviderOptions,
  "extractCost" | "extractProviderRequestId" | "extractTokens" | "redactResponseBody"
>;

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

/** Reads the reported cost from a whole JSON document. */
const readJson = (body: CapturedBody, options: JsonReadOptions): UsageVerdict => {
  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    parseFailed = true;
  }

  const providerRequestId =
    parseFailed ? null : (options.extractProviderRequestId?.(parsed) ?? null);
  const responseBody =
    parseFailed || !options.redactResponseBody
      ? undefined
      : options.redactResponseBody(parsed, body.text);
  const withoutUsage = (reason: string): UsageVerdict => ({
    usage: null,
    providerRequestId,
    reason,
    responseBody,
  });

  if (body.status < 200 || body.status >= 300) {
    return withoutUsage(`Provider responded with HTTP ${body.status}`);
  }
  if (parseFailed) return withoutUsage("Provider returned a non-JSON response");
  const cost = options.extractCost(parsed);
  if (!cost) return withoutUsage("Provider response did not report a cost");
  const tokens = options.extractTokens?.(parsed) ?? { inputTokens: 0, outputTokens: 0 };
  return {
    usage: {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      totalTokens: tokens.inputTokens + tokens.outputTokens,
      costUsd: cost,
    },
    providerRequestId,
    responseBody,
  };
};

/** Buffers a JSON provider response and derives its billing outcome. */
export async function meterJsonResponse(
  upstream: Response,
  options: Pick<JsonProviderOptions, "init"> & JsonReadOptions,
): Promise<MeteredProviderResponse> {
  return meterBuffered(upstream, {
    requestBody: options.init.body,
    reader: { read: (body) => readJson(body, options) },
    headers: "forwardable",
  });
}
