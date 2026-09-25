import type { Fetch } from "../../providers/openrouter/adapter";
import type postgres from "postgres";

import { type AuthenticatedPrincipal, authenticateApiKey, touchApiKey } from "../../auth/api-keys";
import { InsufficientFundsError, LimitExceededError } from "../../billing/errors";
import { screenRequest } from "../abuse-screen";
import { HttpError } from "../http-error";
import {
  type BillingLifecycle,
  type MeteredRequest,
  type MeteredRequestInput,
  runMeteredRequest,
  type SettlementTracker,
} from "../metered-request";
import { RateLimiter } from "../rate-limit";

export type MeteredRouteDependencies = {
  sql: postgres.Sql;
  billing: BillingLifecycle;
  /** Settlements still in flight; the backend drains it on shutdown. */
  settlements: SettlementTracker;
  enforceIdv: boolean;
  rateLimiter?: RateLimiter;
  fetch?: Fetch;
  onSettlementError?: (error: unknown, requestId: string) => void;
};

export const defaultRateLimiter = () =>
  new RateLimiter({ limit: 7_500, windowMs: 30 * 60 * 1_000 });

/** Client address as seen behind Cloudflare, else the proxy header, else empty. */
export const clientIp = (headers: Headers) =>
  headers.get("cf-connecting-ip") ??
  headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  "";

/**
 * The credential a request carries, as an `Authorization` value. Exa's SDKs
 * send the key in `x-api-key` instead of a bearer header; the same Hack Club
 * key is accepted there so those clients work by changing only the base URL.
 */
export const requestAuthorization = (
  headers: Headers,
  options: { acceptApiKeyHeader?: boolean } = {},
): string | undefined => {
  const authorization = headers.get("authorization");
  if (authorization) return authorization;
  const apiKey = options.acceptApiKeyHeader ? headers.get("x-api-key")?.trim() : null;
  return apiKey ? `Bearer ${apiKey}` : undefined;
};

/**
 * The checks every metered provider route shares, in the same order as the
 * OpenRouter proxy: API key, rate limit, abuse screen. The screen runs last so
 * each match is attributed to a user and a refused client keeps its retries
 * inside the rate limit.
 */
export async function authorizeProviderRequest(
  deps: { sql: postgres.Sql; enforceIdv: boolean },
  rateLimiter: RateLimiter,
  request: Request,
  rawBody: string,
  options: { acceptApiKeyHeader?: boolean } = {},
): Promise<AuthenticatedPrincipal> {
  const principal = await authenticateApiKey(
    deps.sql,
    requestAuthorization(request.headers, options),
    { enforceIdv: deps.enforceIdv },
  );
  rateLimiter.consume(principal.userId);
  await screenRequest(deps.sql, principal, {
    headers: request.headers,
    endpoint: new URL(request.url).pathname,
    ip: clientIp(request.headers),
    body: rawBody || null,
  });
  touchApiKey(deps.sql, principal.apiKeyId);
  return principal;
}

export const parseJsonObject = (raw: string): Record<string, unknown> => {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
};

/**
 * OpenAI's SDKs retry every 429 twice unless told otherwise. A spending
 * refusal cannot clear within their backoff, so those retries are wasted.
 */
const NO_RETRY = { "x-should-retry": "false" };

export const billingErrorToHttp = (error: unknown) => {
  if (error instanceof InsufficientFundsError) {
    return new HttpError(
      402,
      "Spending limit reached. Need a higher limit? hey@mahadk.com",
      NO_RETRY,
    );
  }
  if (error instanceof LimitExceededError) return new HttpError(429, error.message, NO_RETRY);
  return null;
};

/** The parts of a metered request each route supplies; the envelope fills in the rest. */
export type ProviderRouteInput = Omit<
  MeteredRequestInput,
  "requestId" | "accountId" | "userId" | "apiKeyId" | "analytics"
> & {
  /** Extra analytics attributes merged after `ip`. */
  attributes?: Record<string, string>;
};

/**
 * The lifecycle every metered provider route shares: one request id, the
 * caller's identity, the analytics block, the billing-error → 429 mapping,
 * and the settlement-error callback.
 *
 * By default the returned `metered.response` is rewrapped with a fresh
 * `Headers` object carrying `x-request-id`, so callers that return it
 * unchanged (exa, ocr, jev) get the header for free; callers that
 * post-process the body into a new Response (images, replicate) must set it
 * themselves on the response they build. Pass `{ rewrapResponse: false }` to
 * skip the rewrap entirely and set the header on whatever response the
 * caller builds instead — the OpenAI-compatible proxy does this because it
 * also filters headers through `forwardableHeaders`.
 */
export async function runProviderRoute(
  deps: Pick<MeteredRouteDependencies, "billing" | "settlements" | "onSettlementError">,
  request: Request,
  principal: AuthenticatedPrincipal,
  input: ProviderRouteInput,
  options: { rewrapResponse?: boolean } = {},
): Promise<{ metered: MeteredRequest; requestId: string }> {
  const requestId = crypto.randomUUID();
  const { attributes, ...route } = input;
  const full: MeteredRequestInput = {
    ...route,
    requestId,
    accountId: principal.billingAccountId,
    userId: principal.userId,
    apiKeyId: principal.apiKeyId,
    analytics: {
      requestHeaders: request.headers,
      attributes: { ip: clientIp(request.headers), ...(attributes ?? {}) },
    },
  };
  let metered: MeteredRequest;
  try {
    metered = await runMeteredRequest(deps.billing, full, deps.settlements);
  } catch (error) {
    throw billingErrorToHttp(error) ?? error;
  }
  metered.settled.catch((error) => deps.onSettlementError?.(error, requestId));
  if (options.rewrapResponse === false) {
    return { metered, requestId };
  }
  const headers = new Headers(metered.response.headers);
  headers.set("x-request-id", requestId);
  metered.response = new Response(metered.response.body, {
    status: metered.response.status,
    statusText: metered.response.statusText,
    headers,
  });
  return { metered, requestId };
}
