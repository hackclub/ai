import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import { executeJsonProvider } from "../../providers/json-provider";
import { forwardableHeaders } from "../../providers/response-headers";
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

const DEFAULT_MODEL = "jev-latest";
const TOKENS_PER_PRICE_UNIT = 1_000_000n;
/**
 * The configured input price is Jev's. Any other model TypeSafe might serve
 * is priced differently, so only the Jev family is forwarded.
 */
const JEV_MODEL = /^jev(-[a-z0-9.]+)?$/i;

const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** `usage.input_tokens` / `usage.output_tokens` from a systemone response, or null when absent. */
export const jevTokens = (body: unknown): { inputTokens: number; outputTokens: number } | null => {
  if (body === null || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return null;
  const { input_tokens, output_tokens } = usage as { input_tokens?: unknown; output_tokens?: unknown };
  const inputTokens = nonNegativeInteger(input_tokens);
  if (inputTokens === null) return null;
  return { inputTokens, outputTokens: nonNegativeInteger(output_tokens) ?? 0 };
};

/** Input tokens priced at `pricePerMillion`; output tokens are free. Null without usage. */
export const jevCost = (body: unknown, pricePerMillion: Usd): Usd | null => {
  const tokens = jevTokens(body);
  if (!tokens) return null;
  return Usd.fromAtoms((pricePerMillion.toAtoms() * BigInt(tokens.inputTokens)) / TOKENS_PER_PRICE_UNIT);
};

/** `jev/<model>`, preferring the versioned id the response reports over the alias requested. */
export const jevModelLabel = (model: unknown, fallback: unknown = DEFAULT_MODEL) => {
  const chosen = typeof model === "string" && model ? model : fallback;
  return `jev/${typeof chosen === "string" && chosen ? chosen : DEFAULT_MODEL}`;
};

const responseModel = (raw: string): string | null => {
  try {
    const model = (JSON.parse(raw) as { model?: unknown })?.model;
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
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
    const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    if (!JEV_MODEL.test(model)) {
      throw new HttpError(400, `Unknown model ${model}. Only Jev models are available.`);
    }
    body.model = model;
    const requestBody = JSON.stringify(body);

    // Analytics read `model` at settlement, so the label can be upgraded to
    // the versioned id the response reports (e.g. jev/jev-1.13.0) before then.
    const input: ProviderRouteInput = {
      provider: "typesafe",
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
        return {
          ...metered,
          completion: metered.completion.then((completion) => {
            if (metered.response.ok) {
              input.model = jevModelLabel(responseModel(completion.responseBody), body.model);
            }
            return completion;
          }),
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
