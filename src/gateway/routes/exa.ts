import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import { EXA, exaCost, exaRequestId } from "../../providers/exa/provider";
import { executeJsonProvider } from "../../providers/json-provider";
import { executeSseProvider } from "../../providers/sse-provider";
import { HttpError } from "../http-error";
import {
  authorizeProviderRequest,
  defaultRateLimiter,
  type MeteredRouteDependencies,
  parseJsonObject,
  runProviderRoute,
} from "./shared";

export type ExaRouteDependencies = MeteredRouteDependencies & {
  exaApiKey: string;
  /** Fixed hold per request; Exa reports actual cost afterwards. */
  reservationUsd?: string;
  baseUrl?: string;
};

export const EXA_ENDPOINTS = ["search", "findSimilar", "contents", "answer"] as const;
export type ExaEndpoint = (typeof EXA_ENDPOINTS)[number];

/**
 * `POST /proxy/v1/exa/{search,findSimilar,contents,answer}`, metered by Exa's
 * reported cost. `/answer` also accepts `stream: true`.
 */
export const exaRoutes = (deps: ExaRouteDependencies) => {
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter();
  const reservation = Usd.parse(deps.reservationUsd ?? "0.02");
  const baseUrl = (deps.baseUrl ?? "https://api.exa.ai").replace(/\/$/, "");

  const handle = async (endpoint: ExaEndpoint, request: Request) => {
    const rawBody = await request.text();
    // Exa's SDKs authenticate with `x-api-key`; accept it alongside bearer auth.
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody, {
      acceptApiKeyHeader: true,
    });

    const body = parseJsonObject(rawBody);
    // Only /answer streams; its cost arrives in the last event.
    const stream = body.stream === true;
    if (stream && endpoint !== "answer") {
      throw new HttpError(400, "Streaming is only supported for Exa's answer endpoint");
    }
    const requestBody = JSON.stringify(body);
    const label = `exa/${endpoint}`;
    const url = `${baseUrl}/${endpoint}`;
    const headers = { "content-type": "application/json", "x-api-key": deps.exaApiKey };

    const { metered } = await runProviderRoute(deps, request, principal, {
      provider: EXA,
      endpoint: label,
      model: label,
      estimatedCostUsd: reservation,
      execute: () =>
        stream
          ? // No abort signal: Exa bills the whole answer even if the client
            // leaves, so the stream is drained to read its cost.
            executeSseProvider({
              fetch: deps.fetch,
              url,
              init: { method: "POST", headers, body: requestBody },
              extractCost: exaCost,
              extractProviderRequestId: exaRequestId,
            })
          : executeJsonProvider({
              fetch: deps.fetch,
              url,
              init: { method: "POST", headers, body: requestBody, signal: request.signal },
              extractCost: exaCost,
              extractProviderRequestId: exaRequestId,
            }),
    });
    return metered.response;
  };

  return new Elysia({ prefix: "/proxy/v1/exa" })
    .post("/search", ({ request }) => handle("search", request))
    .post("/findSimilar", ({ request }) => handle("findSimilar", request))
    .post("/contents", ({ request }) => handle("contents", request))
    .post("/answer", ({ request }) => handle("answer", request));
};
