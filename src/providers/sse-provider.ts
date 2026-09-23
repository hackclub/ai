import type { Usd } from "../billing/money";
import { type JsonProviderOptions, meterJsonResponse } from "./json-provider";
import type { Fetch } from "./openrouter/adapter";
import { forwardableHeaders } from "./response-headers";
import { ServerSentEventParser } from "./sse-parser";
import type { MeteredProviderResponse, ProviderCompletion } from "./types";

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
  const eventStream =
    upstream.headers.get("content-type")?.includes("text/event-stream") ?? false;
  if (!eventStream || !upstream.body) {
    return meterJsonResponse(upstream, {
      init: options.init as JsonProviderOptions["init"],
      extractCost: options.extractCost,
      extractProviderRequestId: options.extractProviderRequestId,
    });
  }

  const maxCapturedBytes = options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES;
  const decoder = new TextDecoder();
  let captured = "";
  let capturedBytes = 0;
  let truncated = false;
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

  let settle: (completion: ProviderCompletion) => void = () => {};
  const completion = new Promise<ProviderCompletion>((resolve) => {
    settle = resolve;
  });
  const outcome = (fallbackReason: string): ProviderCompletion => {
    const bodyCapture = truncated ? "truncated" : "complete";
    if (cost) {
      return {
        state: "complete",
        providerRequestId,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: cost },
        responseBody: captured,
        bodyCapture,
      };
    }
    return {
      state: "uncertain",
      providerRequestId,
      reason: fallbackReason,
      responseBody: captured,
      bodyCapture: truncated ? "truncated" : "partial",
    };
  };

  const reader = upstream.body.getReader();
  let clientGone = false;
  let drainTimedOut = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const pump = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parser.push(next.value);
        if (!truncated && capturedBytes + next.value.byteLength <= maxCapturedBytes) {
          captured += decoder.decode(next.value, { stream: true });
          capturedBytes += next.value.byteLength;
        } else {
          truncated = true;
        }
        if (!clientGone) controller.enqueue(next.value);
      }
      parser.finish();
      settle(
        outcome(
          drainTimedOut
            ? "Client disconnected and the provider sent no cost before the drain timeout"
            : "Provider stream ended without reporting a cost",
        ),
      );
      if (!clientGone) controller.close();
    } catch (error) {
      parser.finish();
      settle(
        outcome(
          clientGone
            ? "Client disconnected before the provider reported a cost"
            : error instanceof Error
              ? error.message
              : "Provider stream failed",
        ),
      );
      if (!clientGone) controller.error(error);
    } finally {
      clearTimeout(drainTimer);
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Pumped rather than pulled, so reading continues after a cancel.
      // Answer streams are small, so ignoring backpressure is harmless.
      void pump(controller);
    },
    cancel() {
      clientGone = true;
      drainTimer = setTimeout(
        () => {
          drainTimedOut = true;
          void reader.cancel("drain timeout").catch(() => {});
        },
        options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      );
    },
  });

  return {
    response: new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: forwardableHeaders(upstream.headers),
    }),
    requestBody: options.init.body,
    completion,
  };
}
