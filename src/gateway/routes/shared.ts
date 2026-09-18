import type { Fetch } from "../../providers/openrouter/adapter";
import type postgres from "postgres";

import { type AuthenticatedPrincipal, authenticateApiKey, touchApiKey } from "../../auth/api-keys";
import { InsufficientFundsError, LimitExceededError } from "../../billing/errors";
import { assertNotBlockedClient } from "../abuse";
import { HttpError } from "../http-error";
import type { BillingLifecycle } from "../metered-request";
import { RateLimiter } from "../rate-limit";

export type MeteredRouteDependencies = {
  sql: postgres.Sql;
  billing: BillingLifecycle;
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
 * OpenRouter proxy: abuse blocklist, API key, rate limit.
 */
export async function authorizeProviderRequest(
  deps: { sql: postgres.Sql; enforceIdv: boolean },
  rateLimiter: RateLimiter,
  request: Request,
  rawBody: string,
  options: { acceptApiKeyHeader?: boolean } = {},
): Promise<AuthenticatedPrincipal> {
  assertNotBlockedClient(request.headers, rawBody);
  const principal = await authenticateApiKey(
    deps.sql,
    requestAuthorization(request.headers, options),
    { enforceIdv: deps.enforceIdv },
  );
  rateLimiter.consume(principal.userId);
  touchApiKey(deps.sql, principal.apiKeyId);
  return principal;
}

export const parseJsonObject = (raw: string): Record<string, unknown> => {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
};

export const billingErrorToHttp = (error: unknown) => {
  if (error instanceof InsufficientFundsError) {
    return new HttpError(429, "Spending limit reached. Need a higher limit? hey@mahadk.com");
  }
  if (error instanceof LimitExceededError) return new HttpError(429, error.message);
  return null;
};
