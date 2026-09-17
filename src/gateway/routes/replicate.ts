import { Elysia } from "elysia";
import type postgres from "postgres";

import { authenticateApiKey, touchApiKey } from "../../auth/api-keys";
import type { BillingEngine } from "../../billing/engine";
import { InsufficientFundsError, LimitExceededError } from "../../billing/errors";
import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import {
  allowedReplicateModels,
  replicateModelCosts,
} from "../../config/replicate-models";
import type { FeatureFlags } from "../../features";
import type {
  MeteredProviderResponse,
  ProviderCompletion,
} from "../../providers/types";
import { assertNotBlockedClient } from "../abuse";
import { HttpError } from "../http-error";
import { runMeteredRequest } from "../metered-request";
import { clientIp } from "../proxy";
import { RateLimiter } from "../rate-limit";

export type ReplicateRouteDependencies = {
  sql: postgres.Sql;
  billing: BillingEngine;
  features: FeatureFlags;
  replicateApiKey: string;
  enforceIdv: boolean;
  fetch?: typeof fetch;
  rateLimiter?: RateLimiter;
  baseUrl?: string;
  onSettlementError?: (error: unknown, requestId: string) => void;
};

const FEATURE_MESSAGE = "Replicate access is not enabled for your account";
const PREDICTION_ID = /^[a-z0-9]+$/;

/** Validates owner/name (ignoring any :version suffix) against the allowlist. */
export const validateModelAccess = (owner: string, name: string) => {
  const cleanName = name.split(":")[0] ?? "";
  const fullId = `${owner}/${cleanName}`;
  if (!allowedReplicateModels.includes(fullId)) {
    throw new HttpError(403, `Model ${fullId} is not in the allowed list.`);
  }
  return fullId;
};

export const versionFromModelName = (name: string) => name.split(":")[1];

export const validateVersionAccess = (model: string, version: string) => {
  if (allowedReplicateModelVersions[version] !== model) {
    throw new HttpError(403, `Model ${model}:${version} is not in the allowed list.`);
  }
};

const fixedCost = (model: string) => Usd.parse(replicateModelCosts.get(model) ?? "0");

/**
 * Wraps a Replicate JSON response for the metered lifecycle. Replicate does
 * not report per-request cost, so a successful prediction bills the fixed
 * price from the config and any other status resolves as uncertain, which
 * the lifecycle finalizes at zero for non-2xx responses.
 */
export const meterFixedCost = (
  upstream: Response,
  requestBody: string,
  costUsd: Usd,
): MeteredProviderResponse => {
  let settle: (completion: ProviderCompletion) => void = () => {};
  const completion = new Promise<ProviderCompletion>((resolve) => {
    settle = resolve;
  });
  const chunks: Uint8Array[] = [];
  const reader = upstream.body?.getReader();
  const captured = () => new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  const finish = () => {
    const body = captured();
    if (upstream.ok) {
      settle({
        state: "complete",
        providerRequestId: null,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd },
        responseBody: body,
        bodyCapture: "complete",
      });
    } else {
      settle({
        state: "uncertain",
        providerRequestId: null,
        reason: `Replicate returned HTTP ${upstream.status}`,
        responseBody: body,
        bodyCapture: "complete",
      });
    }
  };
  if (!reader) {
    finish();
    return { response: upstream, requestBody, completion };
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) {
          chunks.push(next.value.slice());
          controller.enqueue(next.value);
          return;
        }
        finish();
        controller.close();
      } catch (error) {
        settle({
          state: "uncertain",
          providerRequestId: null,
          reason: error instanceof Error ? error.message : "Response stream failed",
          responseBody: captured(),
          bodyCapture: "partial",
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      settle({
        state: "cancelled",
        providerRequestId: null,
        reason: typeof reason === "string" ? reason : "Client cancelled response",
        responseBody: captured(),
        bodyCapture: "partial",
      });
    },
  });
  return {
    response: new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    }),
    requestBody,
    completion,
  };
};

const passthrough = (upstream: Response) => {
  const headers = new Headers(upstream.headers);
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) {
    headers.delete(name);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
};

const readJson = async (request: Request) => {
  const raw = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return { raw, body: body as Record<string, unknown> };
};

/** Every Replicate proxy route under /proxy/v1/replicate. */
export const replicateRoutes = (deps: ReplicateRouteDependencies) => {
  const fetchImplementation = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? "https://api.replicate.com").replace(/\/$/, "");
  const rateLimiter =
    deps.rateLimiter ?? new RateLimiter({ limit: 7_500, windowMs: 30 * 60 * 1_000 });

  const upstreamHeaders = (request: Request) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${deps.replicateApiKey}`,
      "user-agent": "ReplicateProxy/1.0",
    };
    const prefer = request.headers.get("prefer");
    if (prefer) headers.prefer = prefer;
    if (request.headers.get("content-type") === "application/json") {
      headers["content-type"] = "application/json";
    }
    return headers;
  };

  const forward = async (request: Request, path: string, init: RequestInit = {}) =>
    passthrough(
      await fetchImplementation(`${baseUrl}${path}`, {
        headers: upstreamHeaders(request),
        ...init,
      }),
    );

  const withCursor = (request: Request, path: string) => {
    const cursor = new URL(request.url).searchParams.get("cursor");
    return cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
  };

  /** Bills a fixed price and forwards the prediction request. */
  const billedPrediction = async (
    request: Request,
    principal: { userId: string; apiKeyId: string; billingAccountId: string },
    model: string,
    path: string,
    body: Record<string, unknown>,
  ) => {
    const costUsd = fixedCost(model);
    const requestBody = JSON.stringify(body);
    const requestId = crypto.randomUUID();
    let metered;
    try {
      metered = await runMeteredRequest(deps.billing, {
        requestId,
        accountId: principal.billingAccountId,
        provider: "replicate",
        endpoint: "replicate/predictions",
        model,
        estimatedCostUsd: costUsd,
        analytics: {
          userId: principal.userId,
          apiKeyId: principal.apiKeyId,
          requestHeaders: request.headers,
          attributes: { ip: clientIp(request.headers) },
        },
        execute: async () =>
          meterFixedCost(
            await fetchImplementation(`${baseUrl}${path}`, {
              method: "POST",
              headers: upstreamHeaders(request),
              body: requestBody,
              signal: request.signal,
            }),
            requestBody,
            costUsd,
          ),
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new HttpError(429, "Spending limit reached. Need a higher limit? hey@mahadk.com");
      }
      if (error instanceof LimitExceededError) throw new HttpError(429, error.message);
      throw error;
    }
    metered.settled.catch((error) => deps.onSettlementError?.(error, requestId));
    return passthrough(metered.response);
  };

  return new Elysia({ prefix: "/proxy/v1/replicate" })
    .derive(async ({ request }) => {
      assertNotBlockedClient(request.headers, null);
      const principal = await authenticateApiKey(
        deps.sql,
        request.headers.get("authorization") ?? undefined,
        { enforceIdv: deps.enforceIdv },
      );
      rateLimiter.consume(principal.userId);
      touchApiKey(deps.sql, principal.apiKeyId);
      if (!(await deps.features.isEnabled("enable_replicate", principal.userId))) {
        throw new HttpError(403, FEATURE_MESSAGE);
      }
      return { principal };
    })
    // Files
    .post("/files", async ({ request }) => {
      const form = await request.formData().catch(() => null);
      const content = form?.get("content");
      if (!(content instanceof File)) throw new HttpError(400, "File content is required");
      const upload = new FormData();
      upload.append("content", content);
      const metadata = form?.get("metadata");
      if (typeof metadata === "string") upload.append("metadata", metadata);
      return passthrough(
        await fetchImplementation(`${baseUrl}/v1/files`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.replicateApiKey}` },
          body: upload,
        }),
      );
    })
    .get("/files/:id", ({ request, params }) =>
      forward(request, `/v1/files/${encodeURIComponent(params.id)}`),
    )
    .delete("/files/:id", ({ request, params }) =>
      forward(request, `/v1/files/${encodeURIComponent(params.id)}`, { method: "DELETE" }),
    )
    // Deployments
    .post("/deployments/:owner/:name/predictions", async ({ request, params, principal }) => {
      const fullId = validateModelAccess(params.owner, params.name);
      const { body } = await readJson(request);
      return billedPrediction(
        request,
        principal,
        fullId,
        `/v1/deployments/${params.owner}/${params.name}/predictions`,
        body,
      );
    })
    .get("/deployments/:owner/:name", ({ request, params }) => {
      validateModelAccess(params.owner, params.name);
      return forward(request, `/v1/deployments/${params.owner}/${params.name}`);
    })
    .get("/deployments", ({ request }) => forward(request, withCursor(request, "/v1/deployments")))
    // Models
    .post("/models/:owner/:model/predictions", async ({ request, params, principal }) => {
      const fullModelId = validateModelAccess(params.owner, params.model);
      const version = versionFromModelName(params.model);
      const { body } = await readJson(request);

      if (version) {
        validateVersionAccess(fullModelId, version);
        const bodyVersion = typeof body.version === "string" ? body.version : undefined;
        const canonical = `${fullModelId}:${version}`;
        if (bodyVersion && bodyVersion !== version && bodyVersion !== canonical) {
          throw new HttpError(400, "Conflicting version specified in path and request body.");
        }
        const { model: _model, version: _version, ...rest } = body;
        return billedPrediction(request, principal, fullModelId, "/v1/predictions", {
          ...rest,
          version: canonical,
        });
      }
      return billedPrediction(
        request,
        principal,
        fullModelId,
        `/v1/models/${fullModelId}/predictions`,
        body,
      );
    })
    .get("/models/:owner/:model", ({ request, params }) => {
      validateModelAccess(params.owner, params.model);
      return forward(request, `/v1/models/${params.owner}/${params.model}`);
    })
    .get("/models/:owner/:model/versions", ({ request, params }) => {
      validateModelAccess(params.owner, params.model);
      return forward(request, `/v1/models/${params.owner}/${params.model}/versions`);
    })
    .get("/models/:owner/:model/versions/:id", ({ request, params }) => {
      validateModelAccess(params.owner, params.model);
      return forward(
        request,
        `/v1/models/${params.owner}/${params.model}/versions/${encodeURIComponent(params.id)}`,
      );
    })
    // Predictions
    .post("/predictions", async ({ request, principal }) => {
      const { body } = await readJson(request);
      const version = typeof body.version === "string" ? body.version : undefined;
      let modelString = typeof body.model === "string" ? body.model : undefined;
      if (!modelString && version) modelString = allowedReplicateModelVersions[version];
      if (!modelString) {
        throw new HttpError(
          400,
          "Could not validate model access. Please provide the 'model' field (owner/name) in the body, or ensure the 'version' is recognized.",
        );
      }
      const [owner, name] = modelString.split("/");
      if (!owner || !name) throw new HttpError(400, "Invalid model format.");
      const fullModelId = validateModelAccess(owner, name);
      return billedPrediction(request, principal, fullModelId, "/v1/predictions", body);
    })
    .get("/predictions/:id", ({ request, params }) => {
      if (!PREDICTION_ID.test(params.id)) throw new HttpError(400, "Invalid prediction ID");
      return forward(request, `/v1/predictions/${params.id}`);
    })
    .post("/predictions/:id/cancel", ({ request, params }) => {
      if (!PREDICTION_ID.test(params.id)) throw new HttpError(400, "Invalid prediction ID");
      return forward(request, `/v1/predictions/${params.id}/cancel`, { method: "POST" });
    })
    .get("/predictions", ({ request }) => forward(request, withCursor(request, "/v1/predictions")));
};
