import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import { meterJsonResponse } from "../../providers/json-provider";
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
  /** Largest request body after decompression; defaults to 20 MiB. */
  maxBodyBytes?: number;
};

const unzstd = promisify(zstdDecompress);

/**
 * The TypeSafe SDK zstd-compresses bodies of 1 KiB or more, multipart
 * included. Decoded up front so the JSON can be screened and image parts are
 * forwarded intact; the cap stops a small body expanding without bound.
 */
const decodeBody = async (request: Request, maxBytes: number) => {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return request;
  if (encoding !== "zstd") throw new HttpError(415, `Unsupported Content-Encoding ${encoding}`);
  const body = await unzstd(await request.bytes(), { maxOutputLength: maxBytes }).catch((error: { code?: string }) => {
    throw error.code === "ERR_BUFFER_TOO_LARGE"
      ? new HttpError(413, `Request body exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`)
      : new HttpError(400, "Request body is not valid zstd");
  });
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: new Uint8Array(body), signal: request.signal });
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
  const maxBodyBytes = deps.maxBodyBytes ?? 20 * 1024 * 1024;

  const authorize = async (request: Request, rawBody: string) => {
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody);
    return principal;
  };

  const upstreamHeaders = (request: Request) => {
    const headers: Record<string, string> = { authorization: `Bearer ${deps.typesafeApiKey}` };
    for (const [name, value] of request.headers) {
      if (name.startsWith("typesafe-danger-zone-")) headers[name] = value;
    }
    return headers;
  };

  const systemOne = async (received: Request) => {
    const request = await decodeBody(received, maxBodyBytes);
    const form = request.headers.get("content-type")?.startsWith("multipart/form-data")
      ? await request.formData().catch(() => {
          throw new HttpError(400, "Request body must be valid multipart/form-data");
        })
      : null;
    const requestPart = form?.get("request");
    const rawBody = !form
      ? await request.text()
      : typeof requestPart === "string"
        ? requestPart
        : ((await requestPart?.text()) ?? "");
    const principal = await authorize(request, rawBody);

    const body = parseJsonObject(rawBody);
    const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_JEV_MODEL;
    if (!JEV_MODEL.test(model)) {
      throw new HttpError(400, `Unknown model ${model}. Only Jev models are available.`);
    }
    body.model = model;
    const requestBody = JSON.stringify(body);
    form?.set("request", requestBody);

    const input: ProviderRouteInput = {
      provider: TYPESAFE,
      endpoint: "jev/systemone",
      model: jevModelLabel(body.model),
      estimatedCostUsd: reservation,
      uncertainChargeUsd: reservation,
      execute: async () => {
        const upstream = await (deps.fetch ?? fetch)(`${baseUrl}/v1/systemone`, {
          method: "POST",
          headers: form
            ? upstreamHeaders(request)
            : { ...upstreamHeaders(request), "content-type": "application/json" },
          body: form ?? requestBody,
        });
        const metered = await meterJsonResponse(upstream, {
          init: { body: requestBody },
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
      headers: upstreamHeaders(request),
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
