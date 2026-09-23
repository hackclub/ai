import type { Usd } from "../billing/money";

export type NormalizedUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: Usd;
};

type CompletionCommon = {
  providerRequestId: string | null;
  responseBody: string;
  /** The model the provider reports it ran, when it differs from the requested label; analytics prefer it. */
  model?: string;
};

/**
 * How an upstream response ended, as billing needs to know it. The
 * completion alone decides the billing action: settlement never re-reads the
 * HTTP status to override it.
 */
export type ProviderCompletion =
  | (CompletionCommon & {
      state: "complete";
      usage: NormalizedUsage;
      bodyCapture: "complete" | "truncated";
    })
  /** The provider refused the request (non-2xx) and reported no usage: nothing was charged. */
  | (CompletionCommon & {
      state: "provider_error";
      bodyCapture: "complete" | "partial" | "truncated";
    })
  /** A successful response without authoritative usage (cancel, truncation, missing usage). */
  | (CompletionCommon & {
      state: "uncertain";
      reason: string;
      bodyCapture: "complete" | "partial" | "truncated";
    });

export type MeteredProviderResponse = {
  response: Response;
  requestBody: string;
  completion: Promise<ProviderCompletion>;
};
