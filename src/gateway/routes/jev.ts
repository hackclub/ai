import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import { executeJsonProvider } from "../../providers/json-provider";
import { forwardableHeaders } from "../../providers/response-headers";
import {
  DEFAULT_JEV_MODEL,
  JEV_MODEL,
  jevCost,
  jevModelLabel,
  jevResponseModel,
  jevTokens,
  TYPESAFE,
} from "../../providers/typesafe/provider";
import { HttpError } from "../http-error";
import {
  authorizeProviderRequest,
  defaultRateLimiter,
  type MeteredRouteDependencies,
  parseJsonObject,
  type ProviderRouteInput,
  runProviderRoute,
} from "./shared";

export type JevRouteDependencies = MeteredRouteDependencies & {
  typesafeApiKey: string;
  /** Fixed hold per request; the actual charge comes from reported usage. */
  reservationUsd?: string;
  /**
   * Price per million input tokens. TypeSafe reports token usage but no cost,
   * and its model listing carries no pricing, so this is the only source.
   * Output tokens are free (https://docs.typesafe.ai/models).
   */
  inputPricePerMillionTokensUsd?: string;
  baseUrl?: string;
};

/**
 * Jev (TypeSafe's System One model). `POST .../systemone` is metered from the
 * reported token usage; `GET .../models` is a plain passthrough. Both are
 * served under `/proxy/v1/jev` and `/proxy/v1/jev/v1`, the latter so the
 * official SDK works with its base URL pointed at `/proxy/v1/jev`.
 */
export const jevRoutes = (deps: JevRouteDependencies) => {
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter();
  const reservation = Usd.parse(deps.reservationUsd ?? "0.02");
  const inputPrice = Usd.parse(deps.inputPricePerMillionTokensUsd ?? "0.042");
  const baseUrl = (deps.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");

  const authorize = async (request: Request, rawBody: string) => {
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody);
    return principal;
  };

  const upstreamHeaders = () => ({
    "content-type": "application/json",
    authorization: `Bearer ${deps.typesafeApiKey}`,
  });

  const systemOne = async (request: Request) => {
    const rawBody = await request.text();
    const principal = await authorize(request, rawBody);

    const body = parseJsonObject(rawBody);
    const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_JEV_MODEL;
    if (!JEV_MODEL.test(model)) {
      throw new HttpError(400, `Unknown model ${model}. Only Jev models are available.`);
    }
    body.model = model;
    const requestBody = JSON.stringify(body);

    const input: ProviderRouteInput = {
      provider: TYPESAFE,
      endpoint: "jev/systemone",
      model: jevModelLabel(body.model),
      estimatedCostUsd: reservation,
      execute: async () => {
        const metered = await executeJsonProvider({
          fetch: deps.fetch,
          url: `${baseUrl}/v1/systemone`,
          init: { method: "POST", headers: upstreamHeaders(), body: requestBody, signal: request.signal },
          extractCost: (response) => jevCost(response, inputPrice),
          extractTokens: jevTokens,
        });
        // The completion carries the served model (e.g. jev/jev-1.13.0) for analytics.
        return {
          ...metered,
          completion: metered.completion.then((completion) =>
            metered.response.ok
              ? { ...completion, model: jevModelLabel(jevResponseModel(completion.responseBody), body.model) }
              : completion,
          ),
        };
      },
    };

    const { metered } = await runProviderRoute(deps, request, principal, input);
    return metered.response;
  };

  const models = async (request: Request) => {
    await authorize(request, "");
    const upstream = await (deps.fetch ?? fetch)(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: upstreamHeaders(),
      signal: request.signal,
    });
    const headers = forwardableHeaders(upstream.headers);
    return new Response(await upstream.text(), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  };

  return new Elysia({ prefix: "/proxy/v1/jev" })
    .post("/systemone", ({ request }) => systemOne(request))
    .get("/models", ({ request }) => models(request))
    .post("/v1/systemone", ({ request }) => systemOne(request))
    .get("/v1/models", ({ request }) => models(request));
};
