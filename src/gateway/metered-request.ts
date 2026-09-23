import type {
  BillingEngine,
  JsonValue,
  Reservation,
} from "../billing/engine";
import { Usd } from "../billing/money";
import { log } from "../log";
import type {
  MeteredProviderResponse,
  ProviderCompletion,
} from "../providers/types";

/**
 * The subset of the billing engine a metered request needs. Keeping it
 * structural lets the lifecycle be exercised with an in-memory fake.
 */
export type BillingLifecycle = Pick<
  BillingEngine,
  "reserve" | "finalize" | "release" | "markPendingReconciliation"
> & {
  settlements?: SettlementTracker;
};

/** Settlements not yet recorded in billing; drained on shutdown. */
export class SettlementTracker {
  private readonly pending = new Set<Promise<unknown>>();
  track<T>(settled: Promise<T>): Promise<T> {
    const entry: Promise<unknown> = settled.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(entry);
    void entry.finally(() => this.pending.delete(entry));
    return settled;
  }
  get size() {
    return this.pending.size;
  }
  /** Resolves when every tracked settlement has finished or `timeoutMs` elapsed. */
  async drain(timeoutMs: number): Promise<{ remaining: number }> {
    const all = Promise.all([...this.pending]).then(() => undefined);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([all, timeout]);
    return { remaining: this.pending.size };
  }
}

export type MeteredRequestAnalytics = {
  userId?: string | null;
  apiKeyId?: string | null;
  requestHeaders?: HeadersInit;
  attributes?: Record<string, string>;
};

export type MeteredRequestInput = {
  requestId: string;
  accountId: string;
  provider: string;
  endpoint: string;
  model: string;
  estimatedCostUsd: Usd;
  reservationTtlMs?: number;
  analytics?: MeteredRequestAnalytics;
  /** Dispatches the upstream call. Only invoked after the reservation holds. */
  execute: () => Promise<MeteredProviderResponse>;
  /**
   * Called when the dispatch-error path's `billing.release` itself throws.
   * The upstream error is still what's thrown from `runMeteredRequest`; this
   * is purely a reporting hook. Not wired from routes in this plan.
   */
  onReleaseError?: (error: unknown, requestId: string) => void;
};

export type MeteredRequestOutcome =
  | {
      kind: "finalized";
      reservation: Reservation;
      completion: ProviderCompletion;
    }
  | {
      kind: "pending_reconciliation";
      reservation: Reservation;
      completion: ProviderCompletion;
    };

export type MeteredRequest = {
  /** The upstream response, unmodified, for the caller to stream onward. */
  response: Response;
  reservation: Reservation;
  /**
   * Resolves once the provider outcome has been recorded in billing. It
   * settles after the caller finishes reading (or cancels) `response.body`.
   */
  settled: Promise<MeteredRequestOutcome>;
};

/**
 * Headers worth keeping for analytics. Everything else is dropped, so an SDK
 * that carries a credential in a header we have never heard of cannot leak
 * it into ClickHouse. Prefix entries match any header that starts with them.
 */
const ANALYTICS_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-encoding",
  "content-type",
  "content-length",
  "user-agent",
  "referer",
  "http-referer",
  "x-title",
  "origin",
  "x-request-id",
  "cf-ipcountry",
  "cf-ray",
  // response side
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "openai-processing-ms",
]);
const ANALYTICS_HEADER_PREFIXES = ["x-stainless-"];

/** Sanity net: never keep these even if someone adds them to the allow-list. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-openrouter-api-key",
]);

const isAllowed = (key: string) =>
  !SENSITIVE_HEADERS.has(key) &&
  (ANALYTICS_HEADER_ALLOWLIST.has(key) ||
    ANALYTICS_HEADER_PREFIXES.some((prefix) => key.startsWith(prefix)));

/**
 * Keeps only headers worth analytics detail before headers can enter the analytics job
 * payload. Header names are lower-cased so the analytics maps stay stable across clients.
 */
export const redactHeaders = (
  headers: HeadersInit | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!headers) return result;

  new Headers(headers).forEach((value, name) => {
    const key = name.toLowerCase();
    if (isAllowed(key)) result[key] = value;
  });
  return result;
};

const elapsedMs = (startedAt: number) =>
  Math.max(0, Math.round(performance.now() - startedAt));

const isSuccess = (status: number) => status >= 200 && status < 300;

const isEventStream = (response: Response) =>
  response.headers.get("content-type")?.includes("text/event-stream") ??
  false;

type AnalyticsContext = {
  input: MeteredRequestInput;
  response: Response;
  requestBody: string;
  timeToFirstByteMs: number;
  durationMs: number;
};

const analyticsEvent = (
  context: AnalyticsContext,
  completion: ProviderCompletion,
  outcome: string,
  errorCode: string,
): Record<string, JsonValue> => {
  const { input, response } = context;
  const usage = completion.state === "complete" ? completion.usage : null;

  return {
    user_id: input.analytics?.userId ?? null,
    api_key_id: input.analytics?.apiKeyId ?? null,
    endpoint: input.endpoint,
    model: input.model,
    outcome,
    error_code: errorCode,
    http_status: response.status,
    streamed: isEventStream(response),
    duration_ms: context.durationMs,
    time_to_first_byte_ms: context.timeToFirstByteMs,
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    provider_cost_usd: usage ? usage.costUsd.toString() : null,
    request_headers: redactHeaders(input.analytics?.requestHeaders),
    response_headers: redactHeaders(response.headers),
    attributes: {
      ...(input.analytics?.attributes ?? {}),
      body_capture: completion.bodyCapture,
    },
    request_body: context.requestBody,
    response_body: completion.responseBody,
  };
};

const settleCompletion = async (
  billing: BillingLifecycle,
  context: AnalyticsContext,
  completion: ProviderCompletion,
): Promise<MeteredRequestOutcome> => {
  const { input, response } = context;
  const providerRequestId = completion.providerRequestId ?? undefined;

  if (completion.state === "complete") {
    const reservation = await billing.finalize({
      requestId: input.requestId,
      actualCostUsd: completion.usage.costUsd,
      usageSource: "provider_reported",
      providerRequestId,
      analytics: analyticsEvent(context, completion, "completed", ""),
    });
    return { kind: "finalized", reservation, completion };
  }

  if (!isSuccess(response.status)) {
    // The provider refused the request, so nothing was generated or charged.
    // Finalizing at zero closes the reservation and still records the
    // failed request for search and analytics.
    const reservation = await billing.finalize({
      requestId: input.requestId,
      actualCostUsd: Usd.zero,
      usageSource: "calculated",
      providerRequestId,
      analytics: analyticsEvent(
        context,
        completion,
        "provider_error",
        `http_${response.status}`,
      ),
    });
    return { kind: "finalized", reservation, completion };
  }

  // A successful response that ended without authoritative usage (client
  // cancellation, truncated stream, missing usage block) may still have been
  // charged upstream. The reservation stays held until reconciled.
  const reservation = await billing.markPendingReconciliation(
    input.requestId,
    completion.reason,
    providerRequestId,
  );
  return { kind: "pending_reconciliation", reservation, completion };
};

/**
 * Runs one upstream request through the billing lifecycle:
 *
 * 1. Reserve the estimate. Insufficient funds or an exceeded limit throws
 *    before any provider call is made.
 * 2. Dispatch. A transport failure releases the reservation and rethrows.
 * 3. Once the response has been fully consumed or cancelled, finalize with
 *    the provider-reported cost, finalize at zero for a provider HTTP error,
 *    or mark the reservation pending reconciliation when the outcome is
 *    uncertain.
 */
export async function runMeteredRequest(
  billing: BillingLifecycle,
  input: MeteredRequestInput,
): Promise<MeteredRequest> {
  const reservation = await billing.reserve({
    requestId: input.requestId,
    accountId: input.accountId,
    provider: input.provider,
    estimatedCostUsd: input.estimatedCostUsd,
    ttlMs: input.reservationTtlMs,
  });

  const startedAt = performance.now();
  let metered: MeteredProviderResponse;
  try {
    metered = await input.execute();
  } catch (error) {
    try {
      await billing.release(input.requestId);
    } catch (releaseError) {
      // The upstream failure is the useful signal; the leaked hold is
      // recovered by the expiry sweeper. Report both, rethrow the original.
      input.onReleaseError?.(releaseError, input.requestId);
    }
    throw error;
  }
  const timeToFirstByteMs = elapsedMs(startedAt);

  // Adapters resolve `completion` on every path, but the type cannot promise
  // it. A rejection is treated as an unknown outcome so the reservation is
  // still settled (held for reconciliation) rather than left to expire.
  const completion = metered.completion.catch((error: unknown): ProviderCompletion => {
    log.error({ err: error, requestId: input.requestId }, "provider completion rejected");
    return {
      state: "uncertain",
      providerRequestId: null,
      reason: "completion_rejected",
      responseBody: "",
      bodyCapture: "partial",
    };
  });
  const raw = completion.then((completion) =>
    settleCompletion(
      billing,
      {
        input,
        response: metered.response,
        requestBody: metered.requestBody,
        timeToFirstByteMs,
        durationMs: elapsedMs(startedAt),
      },
      completion,
    ),
  );
  const settled = billing.settlements ? billing.settlements.track(raw) : raw;

  return { response: metered.response, reservation, settled };
}
