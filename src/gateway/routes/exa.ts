import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import { executeJsonProvider } from "../../providers/json-provider";
import { HttpError } from "../http-error";
import { runMeteredRequest } from "../metered-request";
import {
  authorizeProviderRequest,
  billingErrorToHttp,
  clientIp,
  defaultRateLimiter,
  type MeteredRouteDependencies,
  parseJsonObject,
} from "./shared";

export type ExaRouteDependencies = MeteredRouteDependencies & {
  exaApiKey: string | null;
  /** Fixed hold per request; Exa reports actual cost afterwards. */
  reservationUsd?: string;
  baseUrl?: string;
};

export const EXA_ENDPOINTS = ["search", "findSimilar", "contents", "answer"] as const;
export type ExaEndpoint = (typeof EXA_ENDPOINTS)[number];


/** `costDollars.total` from an Exa response, or null. */
export const exaCost = (body: unknown): Usd | null => {
  if (body === null || typeof body !== "object") return null;
  const cost = (body as { costDollars?: { total?: unknown } }).costDollars?.total;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  return Usd.fromNumber(cost);
};

export const exaRequestId = (body: unknown) =>
  body !== null && typeof body === "object" && typeof (body as { requestId?: unknown }).requestId === "string"
    ? (body as { requestId: string }).requestId
    : null;

/** `POST /proxy/v1/exa/{search,findSimilar,contents,answer}`, metered by Exa's reported cost. */
export const exaRoutes = (deps: ExaRouteDependencies) => {
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter();
  const reservation = Usd.parse(deps.reservationUsd ?? "0.02");
  const baseUrl = (deps.baseUrl ?? "https://api.exa.ai").replace(/\/$/, "");

  const handle = async (endpoint: ExaEndpoint, request: Request) => {
    const rawBody = await request.text();
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody);
    if (!deps.exaApiKey) throw new HttpError(503, "Exa is not configured");

    const body = parseJsonObject(rawBody);
    if (body.stream === true) {
      throw new HttpError(400, "Streaming is not supported for Exa endpoints");
    }
    const requestBody = JSON.stringify(body);
    const label = `exa/${endpoint}`;
    const requestId = crypto.randomUUID();

    let metered;
    try {
      metered = await runMeteredRequest(deps.billing, {
        requestId,
        accountId: principal.billingAccountId,
        provider: "exa",
        endpoint: label,
        model: label,
        estimatedCostUsd: reservation,
        analytics: {
          userId: principal.userId,
          apiKeyId: principal.apiKeyId,
          requestHeaders: request.headers,
          attributes: { ip: clientIp(request.headers) },
        },
        execute: () =>
          executeJsonProvider({
            fetch: deps.fetch,
            url: `${baseUrl}/${endpoint}`,
            init: {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": deps.exaApiKey ?? "" },
              body: requestBody,
              signal: request.signal,
            },
            extractCost: exaCost,
            extractProviderRequestId: exaRequestId,
          }),
      });
    } catch (error) {
      throw billingErrorToHttp(error) ?? error;
    }
    metered.settled.catch((error) => deps.onSettlementError?.(error, requestId));
    return metered.response;
  };

  return new Elysia({ prefix: "/proxy/v1/exa" })
    .post("/search", ({ request }) => handle("search", request))
    .post("/findSimilar", ({ request }) => handle("findSimilar", request))
    .post("/contents", ({ request }) => handle("contents", request))
    .post("/answer", ({ request }) => handle("answer", request));
};
