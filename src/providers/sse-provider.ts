import type { Usd } from "../billing/money";
import { type JsonProviderOptions, meterJsonResponse } from "./json-provider";
import { type BodyEnd, isEventStream, meterStreamed } from "./metered-body";
import type { Fetch } from "./openrouter/adapter";
import { ServerSentEventParser } from "./sse-parser";
import type { MeteredProviderResponse } from "./types";

export type SseProviderOptions = {
  url: string;
  /** No `signal`: a client disconnect must not abort the upstream call. */
  init: Omit<RequestInit, "signal"> & { body: string };
  fetch?: Fetch;
  /** Provider-reported cost carried by one event, or null. */
  extractCost: (event: unknown) => Usd | null;
  extractProviderRequestId?: (event: unknown) => string | null;
  /** How long to keep reading after the client leaves, to see the cost. */
  drainTimeoutMs?: number;
  maxCapturedBytes?: number;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CAPTURED_BYTES = 1024 * 1024;

const ENDED_WITHOUT_COST = "Provider stream ended without reporting a cost";

const missingCostReason = (end: BodyEnd): string => {
  switch (end.kind) {
    case "done":
      return ENDED_WITHOUT_COST;
    case "error":
      return end.error instanceof Error ? end.error.message : "Provider stream failed";
    case "cancelled":
      switch (end.drain) {
        case "timed_out":
          return "Client disconnected and the provider sent no cost before the drain timeout";
        case "failed":
          return "Client disconnected before the provider reported a cost";
        default:
          return ENDED_WITHOUT_COST;
      }
  }
};

/**
 * Executes a streaming provider call whose cost arrives in an event (Exa's
 * `/answer` sends `costDollars` in its last event). The provider charges for
 * the whole answer however early the client leaves, so after a disconnect
 * the upstream stream keeps being read, for at most `drainTimeoutMs`, until
 * the cost is seen. A non-stream reply (an error, or a provider that ignored
 * `stream`) is metered as a plain JSON response.
 */
export async function executeSseProvider(
  options: SseProviderOptions,
): Promise<MeteredProviderResponse> {
  const upstream = await (options.fetch ?? fetch)(options.url, options.init);
  if (!isEventStream(upstream.headers) || !upstream.body) {
    return meterJsonResponse(upstream, {
      init: options.init as JsonProviderOptions["init"],
      extractCost: options.extractCost,
      extractProviderRequestId: options.extractProviderRequestId,
    });
  }

  let cost: Usd | null = null;
  let providerRequestId: string | null = null;
  const parser = new ServerSentEventParser(({ data }) => {
    try {
      const value: unknown = JSON.parse(data);
      cost = options.extractCost(value) ?? cost;
      providerRequestId = options.extractProviderRequestId?.(value) ?? providerRequestId;
    } catch {
      // Not a billing fact; the bytes still reach the client and analytics.
    }
  });

  return meterStreamed(upstream, {
    requestBody: options.init.body,
    reader: {
      observe: (chunk) => parser.push(chunk),
      read: ({ end }) => {
        parser.finish();
        return cost
          ? {
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: cost },
              providerRequestId,
            }
          : { usage: null, providerRequestId, reason: missingCostReason(end) };
      },
    },
    maxCapturedBytes: options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES,
    headers: "forwardable",
    onCancel: { kind: "drain", timeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS },
  });
}
