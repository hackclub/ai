import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { allowedReplicateModels } from "../../config/replicate-models";
import {
  createReplicatePricingSource,
  estimatePredictionCost,
  hasBillableMetrics,
  predictionCost,
  type ReplicatePricing,
  type ReplicatePricingSource,
} from "../../providers/replicate/pricing";
import {
  fetchReplicatePrediction,
  isTerminal,
  parsePrediction,
  type PredictionSnapshot,
} from "../../providers/replicate/predictions";
import {
  ownsReplicateResource,
  recordReplicateResource,
  type ReplicateResourceKind,
} from "../../providers/replicate/resources";
import { forwardableHeaders } from "../../providers/response-headers";
import type {
  MeteredProviderResponse,
  ProviderCompletion,
} from "../../providers/types";
import { assertNotBlockedClient } from "../abuse";
import { HttpError } from "../http-error";
import {
  authorizeProviderRequest,
  defaultRateLimiter,
  type MeteredRouteDependencies,
  parseJsonObject,
  type ProviderRouteInput,
  runProviderRoute,
} from "./shared";

export type ReplicateRouteDependencies = MeteredRouteDependencies & {
  replicateApiKey: string;
  /** Replicate API origin. */
  baseUrl?: string;
  /** This gateway's public origin, used to rewrite Replicate's API links in responses. */
  publicBaseUrl?: string;
  pricing?: ReplicatePricingSource;
  /** How long to keep polling an async prediction for its final metrics. */
  settlementTimeoutMs?: number;
  /**
   * Smallest hold placed before dispatch. Models whose page carries no median
   * run price would otherwise estimate to $0, which passes every funding and
   * limit check. Defaults to 0.05 USD.
   */
  minimumHoldUsd?: string;
  /** Largest accepted file upload; defaults to 20 MiB. */
  maxUploadBytes?: number;
};

/**
 * Margin added to the settlement window for the reservation's lifetime: the
 * `Prefer: wait` phase (up to 60 s) and the final poll. A reservation the
 * expiry sweeper releases mid-flight loses its charge.
 */
const RESERVATION_TTL_MARGIN_MS = 5 * 60 * 1_000;

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

const VERSION_ID = /^[0-9a-f]{64}$/;

export type ModelReference = {
  /** Allowlisted owner/name. */
  model: string;
  /** `owner/name:version` when a specific allowlisted version was named, else null. */
  version: string | null;
};

const parseOwnerName = (value: string) => {
  const [owner, name, ...rest] = value.split("/");
  if (!owner || !name || rest.length > 0) throw new HttpError(400, "Invalid model format.");
  return validateModelAccess(owner, name);
};

/**
 * Resolves the `version` field of a prediction request, which Replicate
 * accepts as a bare 64-character version id, `owner/name:version`, or
 * `owner/name` for official models. Whatever form it takes, the reference
 * must land on an allowlisted model (and version, when one is named).
 */
export const resolveModelReference = (reference: string): ModelReference => {
  if (VERSION_ID.test(reference)) {
    const model = allowedReplicateModelVersions[reference];
    if (!model) throw new HttpError(403, `Version ${reference} is not in the allowed list.`);
    return { model, version: `${model}:${reference}` };
  }
  const [ownerName, versionId, ...rest] = reference.split(":");
  if (!ownerName || rest.length > 0) throw new HttpError(400, "Invalid model format.");
  const model = parseOwnerName(ownerName);
  if (versionId === undefined) return { model, version: null };
  validateVersionAccess(model, versionId);
  return { model, version: `${model}:${versionId}` };
};

const POLL_DELAYS_MS = [1_000, 2_000, 3_000, 5_000];
const MAX_CONSECUTIVE_LOOKUP_FAILURES = 5;

export type PredictionSettlement = {
  pricing: ReplicatePricing;
  /** Fetches the current state of a prediction by id. */
  lookup: (id: string) => Promise<PredictionSnapshot | null>;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Waits until a prediction reaches a terminal status. A `Prefer: wait`
 * response is usually terminal already; otherwise the prediction is polled
 * with a gentle backoff until the deadline passes.
 */
const awaitTerminal = async (
  initial: PredictionSnapshot,
  settlement: PredictionSettlement,
): Promise<PredictionSnapshot | null> => {
  if (isTerminal(initial)) return initial;
  if (!initial.id) return null;
  const sleep = settlement.sleep ?? Bun.sleep;
  const deadline = Date.now() + settlement.timeoutMs;
  let consecutiveFailures = 0;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    await sleep(POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)] ?? 5_000);
    let latest: PredictionSnapshot | null;
    try {
      latest = await settlement.lookup(initial.id);
      consecutiveFailures = 0;
    } catch (error) {
      // A transient upstream error is retried; a run of them is given up on
      // so a dead upstream still resolves within the settlement window.
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_LOOKUP_FAILURES) throw error;
      continue;
    }
    if (isTerminal(latest)) return latest;
  }
  return null;
};

/**
 * Wraps a Replicate prediction response for the metered lifecycle. The body
 * streams to the client untouched; once it has been read, the prediction is
 * followed to a terminal status and billed from its reported metrics. Failed
 * and cancelled predictions still bill any hardware time Replicate reports.
 * Anything that prevents reading final metrics resolves as uncertain so the
 * reservation is held for reconciliation instead of being guessed.
 */
export const meterPrediction = (
  upstream: Response,
  requestBody: string,
  settlement: PredictionSettlement,
): MeteredProviderResponse => {
  let settle: (completion: ProviderCompletion) => void = () => {};
  const completion = new Promise<ProviderCompletion>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const settleOnce = (result: ProviderCompletion) => {
    if (settled) return;
    settled = true;
    settle(result);
  };
  const chunks: Uint8Array[] = [];
  const reader = upstream.body?.getReader();
  const captured = () => new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  // The prediction id is kept on every uncertain outcome so reconciliation
  // can look the prediction up later instead of releasing the hold unbilled.
  const uncertain = (
    reason: string,
    bodyCapture: "complete" | "partial" = "complete",
    predictionId: string | null = null,
  ) =>
    settleOnce({
      state: "uncertain",
      providerRequestId: predictionId,
      reason,
      responseBody: captured(),
      bodyCapture,
    });
  const finish = async () => {
    const body = captured();
    if (!upstream.ok) {
      uncertain(`Replicate returned HTTP ${upstream.status}`);
      return;
    }
    const initial = parsePrediction(body);
    if (!initial) {
      uncertain("Replicate response was not a prediction object");
      return;
    }
    const predictionId = initial.id ?? null;
    let final: PredictionSnapshot | null;
    try {
      final = await awaitTerminal(initial, settlement);
    } catch (error) {
      uncertain(
        error instanceof Error ? error.message : "Prediction lookup failed",
        "complete",
        predictionId,
      );
      return;
    }
    if (!final) {
      uncertain(
        `Prediction ${predictionId ?? "?"} did not finish within the settlement window`,
        "complete",
        predictionId,
      );
      return;
    }
    const metrics = final.metrics ?? {};
    // A successful run without the metric its price is keyed on cannot be
    // billed from the response. Holding it for reconciliation beats closing
    // it at $0 as if Replicate had reported nothing to charge.
    if (final.status === "succeeded" && !hasBillableMetrics(settlement.pricing, metrics)) {
      uncertain(
        `Prediction ${predictionId ?? "?"} succeeded without billable metrics`,
        "complete",
        final.id ?? predictionId,
      );
      return;
    }
    settleOnce({
      state: "complete",
      providerRequestId: final.id ?? predictionId,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: predictionCost(settlement.pricing, metrics),
      },
      responseBody: body,
      bodyCapture: "complete",
    });
  };
  if (!reader) {
    void finish();
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
        controller.close();
        void finish();
      } catch (error) {
        uncertain(error instanceof Error ? error.message : "Response stream failed", "partial");
        controller.error(error);
      }
    },
    async cancel(reason) {
      // The upstream may already be gone (aborted fetch, closed socket). A
      // rejected cancel must not leave `completion` unsettled, or the
      // reservation would only ever close by expiry.
      await reader.cancel(reason).catch(() => {});
      const body = captured();
      // Replicate creates the prediction before responding, so a cancelled
      // read still names a run that may be billed; keep its id for
      // reconciliation, exactly as `finish()` does.
      const predictionId = upstream.ok ? (parsePrediction(body)?.id ?? null) : null;
      settleOnce({
        state: "cancelled",
        providerRequestId: predictionId,
        reason: typeof reason === "string" ? reason : "Client cancelled response",
        responseBody: body,
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

const LINK_KEYS = new Set(["get", "cancel", "next", "previous"]);
const OPAQUE_KEYS = new Set(["input", "output", "logs"]);

/**
 * Replicate responses link back to api.replicate.com (`urls.get`,
 * `urls.cancel`, pagination `next`/`previous`). Clients such as the official
 * SDK follow those links verbatim with the proxy credentials, so they are
 * rewritten to point at this gateway. Model inputs and outputs are left alone.
 */
export const rewriteUpstreamLinks = (value: unknown, from: string, to: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => rewriteUpstreamLinks(item, from, to));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (OPAQUE_KEYS.has(key)) {
      result[key] = entry;
    } else if (LINK_KEYS.has(key) && typeof entry === "string" && entry.startsWith(from)) {
      result[key] = `${to}${entry.slice(from.length)}`;
    } else {
      result[key] = rewriteUpstreamLinks(entry, from, to);
    }
  }
  return result;
};

const passthrough = (upstream: Response) =>
  new Response(upstream.body, { status: upstream.status, headers: forwardableHeaders(upstream.headers) });

const readJson = async (request: Request) => {
  const raw = await request.text();
  return { raw, body: parseJsonObject(raw) };
};

/** Every Replicate proxy route under /proxy/v1/replicate. */
export const replicateRoutes = (deps: ReplicateRouteDependencies) => {
  const fetchImplementation = (deps.fetch ?? fetch) as typeof fetch;
  const baseUrl = (deps.baseUrl ?? "https://api.replicate.com").replace(/\/$/, "");
  const publicBaseUrl = (deps.publicBaseUrl ?? "http://localhost:3000").replace(/\/$/, "");
  const upstreamLinkPrefix = `${baseUrl}/v1/`;
  const publicLinkPrefix = `${publicBaseUrl}/proxy/v1/replicate/`;
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter();
  const pricingSource = deps.pricing ?? createReplicatePricingSource({ fetch: fetchImplementation });
  const settlementTimeoutMs = deps.settlementTimeoutMs ?? 15 * 60 * 1_000;
  const minimumHold = Usd.parse(deps.minimumHoldUsd ?? "0.05");
  const maxUploadBytes = deps.maxUploadBytes ?? 20 * 1024 * 1024;

  const resolvePricing = async (model: string) => {
    let pricing: ReplicatePricing | null;
    try {
      pricing = await pricingSource.get(model);
    } catch {
      pricing = null;
    }
    if (!pricing) {
      throw new HttpError(503, `Pricing for ${model} is unavailable right now. Please retry shortly.`);
    }
    return pricing;
  };

  const lookupPrediction = async (id: string) => {
    const lookup = await fetchReplicatePrediction(id, {
      apiKey: deps.replicateApiKey,
      baseUrl,
      fetch: fetchImplementation,
    });
    if (lookup.state === "not_found") {
      throw new Error(`Prediction ${id} lookup returned HTTP 404`);
    }
    return lookup.prediction;
  };

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

  /**
   * Buffers a JSON response so Replicate's API links can be rewritten to this
   * gateway. Non-JSON bodies pass through unchanged.
   */
  const rewrittenJson = async (upstream: Response) => {
    const text = await upstream.text();
    const headers = forwardableHeaders(upstream.headers);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { parsed, response: new Response(text, { status: upstream.status, headers }) };
    }
    const body = JSON.stringify(rewriteUpstreamLinks(parsed, upstreamLinkPrefix, publicLinkPrefix));
    return { parsed, response: new Response(body, { status: upstream.status, headers }) };
  };

  const forward = async (request: Request, path: string, init: RequestInit = {}) =>
    passthrough(
      await fetchImplementation(`${baseUrl}${path}`, {
        headers: upstreamHeaders(request),
        ...init,
      }),
    );

  const forwardJson = async (request: Request, path: string, init: RequestInit = {}) =>
    (
      await rewrittenJson(
        await fetchImplementation(`${baseUrl}${path}`, {
          headers: upstreamHeaders(request),
          ...init,
        }),
      )
    ).response;

  /** Resources are only visible to the user who created them through the proxy. */
  const assertOwner = async (kind: ReplicateResourceKind, id: string, userId: string) => {
    if (!(await ownsReplicateResource(deps.sql, kind, id, userId))) {
      throw new HttpError(404, `${kind === "file" ? "File" : "Prediction"} ${id} not found.`);
    }
  };

  const idOf = (value: unknown) =>
    value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id
      : null;

  const notListable = (what: string) => () => {
    throw new HttpError(
      404,
      `Listing ${what} is not available through the proxy. Keep the ids of the ${what} you create.`,
    );
  };

  /**
   * Holds an estimate from the model's live pricing, forwards the prediction,
   * records who created it, and settles the real cost from the prediction's
   * metrics.
   */
  const billedPrediction = async (
    request: Request,
    principal: { userId: string; apiKeyId: string; billingAccountId: string },
    reference: ModelReference,
    raw: string,
    body: Record<string, unknown>,
  ) => {
    assertNotBlockedClient(request.headers, raw);
    // Replicate would POST results to any URL named here, from its own
    // network, under the shared account token; and the URL (often carrying
    // the caller's secret) would be stored as request_body. Not supported.
    if ("webhook" in body || "webhook_events_filter" in body) {
      throw new HttpError(400, "Webhooks are not supported through the proxy; poll the prediction instead.");
    }
    const { model } = reference;
    const path = reference.version ? "/v1/predictions" : `/v1/models/${model}/predictions`;
    const { model: _model, version: _version, ...rest } = body;
    const payload = reference.version ? { ...rest, version: reference.version } : rest;
    const pricing = await resolvePricing(model);
    const input =
      payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
        ? (payload.input as Record<string, unknown>)
        : {};
    const estimate = estimatePredictionCost(pricing, input);
    const costUsd = estimate.toAtoms() < minimumHold.toAtoms() ? minimumHold : estimate;
    const requestBody = JSON.stringify(payload);
    const { metered, requestId } = await runProviderRoute(deps, request, principal, {
      provider: "replicate",
      endpoint: "replicate/predictions",
      model,
      estimatedCostUsd: costUsd,
      reservationTtlMs: settlementTimeoutMs + RESERVATION_TTL_MARGIN_MS,
      // The client's abort signal is deliberately not forwarded: Replicate
      // creates the prediction before a `Prefer: wait` response returns,
      // so aborting the upstream call would release the hold for a run
      // that still executes (and still delivers to any webhook).
      execute: async () =>
        meterPrediction(
          await fetchImplementation(`${baseUrl}${path}`, {
            method: "POST",
            headers: upstreamHeaders(request),
            body: requestBody,
          }),
          requestBody,
          { pricing, lookup: lookupPrediction, timeoutMs: settlementTimeoutMs },
        ),
    } satisfies ProviderRouteInput);
    // A prediction response is a single JSON document, so buffering it costs
    // nothing and lets ownership be recorded before the client can poll.
    const { parsed, response } = await rewrittenJson(metered.response);
    const id = metered.response.ok ? idOf(parsed) : null;
    if (id) {
      try {
        await recordReplicateResource(deps.sql, {
          kind: "prediction",
          id,
          userId: principal.userId,
          apiKeyId: principal.apiKeyId,
          model,
        });
      } catch (error) {
        // The prediction exists upstream and its hold is placed; a lost
        // ownership row must not turn that into a 500. The user keeps the id
        // from the body; the row can be repaired by hand from this report.
        deps.onSettlementError?.(
          new Error(`Failed to record ownership of prediction ${id}`, { cause: error }),
          requestId,
        );
      }
    }
    return response;
  };

  return new Elysia({ prefix: "/proxy/v1/replicate" })
    .derive(async ({ request }) => ({
      principal: await authorizeProviderRequest(deps, rateLimiter, request, ""),
    }))
    // Files
    .post("/files", async ({ request, principal }) => {
      const form = await request.formData().catch(() => null);
      const content = form?.get("content");
      if (!(content instanceof File)) throw new HttpError(400, "File content is required");
      if (content.size > maxUploadBytes) {
        throw new HttpError(413, `File exceeds the ${Math.floor(maxUploadBytes / 1024 / 1024)} MiB upload limit`);
      }
      const upload = new FormData();
      upload.append("content", content);
      // The official SDK sends metadata as a JSON blob part; curl users send a string.
      const metadata = form?.get("metadata");
      if (typeof metadata === "string" || metadata instanceof Blob) {
        upload.append("metadata", metadata);
      }
      for (const field of ["type", "filename"]) {
        const value = form?.get(field);
        if (typeof value === "string") upload.append(field, value);
      }
      const { parsed, response } = await rewrittenJson(
        await fetchImplementation(`${baseUrl}/v1/files`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.replicateApiKey}` },
          body: upload,
        }),
      );
      const id = response.ok ? idOf(parsed) : null;
      if (id) {
        try {
          await recordReplicateResource(deps.sql, {
            kind: "file",
            id,
            userId: principal.userId,
            apiKeyId: principal.apiKeyId,
          });
        } catch (error) {
          // The file exists upstream; a lost ownership row must not turn
          // that into a 500. The user keeps the id from the body.
          deps.onSettlementError?.(new Error(`Failed to record ownership of file ${id}`, { cause: error }), id);
        }
      }
      return response;
    })
    .get("/files", notListable("files"))
    .get("/files/:id", async ({ request, params, principal }) => {
      await assertOwner("file", params.id, principal.userId);
      return forwardJson(request, `/v1/files/${encodeURIComponent(params.id)}`);
    })
    .get("/files/:id/download", async ({ request, params, principal }) => {
      await assertOwner("file", params.id, principal.userId);
      const query = new URL(request.url).search;
      return forward(request, `/v1/files/${encodeURIComponent(params.id)}/download${query}`);
    })
    .delete("/files/:id", async ({ request, params, principal }) => {
      await assertOwner("file", params.id, principal.userId);
      return forward(request, `/v1/files/${encodeURIComponent(params.id)}`, { method: "DELETE" });
    })
    // Models
    .post("/models/:owner/:model/predictions", async ({ request, params, principal }) => {
      const fullModelId = validateModelAccess(params.owner, params.model);
      const pathVersion = versionFromModelName(params.model);
      const { raw, body } = await readJson(request);
      const bodyVersion = typeof body.version === "string" ? body.version : undefined;
      if (pathVersion) {
        const reference = resolveModelReference(`${fullModelId}:${pathVersion}`);
        if (bodyVersion && bodyVersion !== pathVersion && bodyVersion !== reference.version) {
          throw new HttpError(400, "Conflicting version specified in path and request body.");
        }
        return billedPrediction(request, principal, reference, raw, body);
      }
      if (bodyVersion) {
        const reference = resolveModelReference(bodyVersion);
        if (reference.model !== fullModelId) {
          throw new HttpError(400, "Conflicting model specified in path and request body.");
        }
        return billedPrediction(request, principal, reference, raw, body);
      }
      return billedPrediction(request, principal, { model: fullModelId, version: null }, raw, body);
    })
    // Upstream paths are built from the allowlisted id, never from the raw
    // params: Elysia decodes `%2F`, so a decoded `..` segment would otherwise
    // let a caller reach any /v1 endpoint with the shared account token.
    .get("/models/:owner/:model", ({ request, params }) => {
      const fullId = validateModelAccess(params.owner, params.model);
      return forward(request, `/v1/models/${fullId}`);
    })
    .get("/models/:owner/:model/versions", ({ request, params }) => {
      const fullId = validateModelAccess(params.owner, params.model);
      return forwardJson(request, `/v1/models/${fullId}/versions`);
    })
    .get("/models/:owner/:model/versions/:id", ({ request, params }) => {
      const fullId = validateModelAccess(params.owner, params.model);
      if (!VERSION_ID.test(params.id)) throw new HttpError(400, "Invalid version ID");
      return forward(request, `/v1/models/${fullId}/versions/${params.id}`);
    })
    // Predictions
    .post("/predictions", async ({ request, principal }) => {
      const { raw, body } = await readJson(request);
      const version = typeof body.version === "string" ? body.version : undefined;
      const model = typeof body.model === "string" ? body.model : undefined;
      if (!version && !model) {
        throw new HttpError(
          400,
          "Provide 'version' (a version id, owner/name:version, or owner/name) or 'model' (owner/name).",
        );
      }
      // `version` is what Replicate runs, so access is decided from it alone.
      const reference = version ? resolveModelReference(version) : resolveModelReference(model ?? "");
      if (version && model && parseOwnerName(model) !== reference.model) {
        throw new HttpError(400, "Conflicting model and version specified in request body.");
      }
      return billedPrediction(request, principal, reference, raw, body);
    })
    .get("/predictions", notListable("predictions"))
    .get("/predictions/:id", async ({ request, params, principal }) => {
      if (!PREDICTION_ID.test(params.id)) throw new HttpError(400, "Invalid prediction ID");
      await assertOwner("prediction", params.id, principal.userId);
      return forwardJson(request, `/v1/predictions/${params.id}`);
    })
    .post("/predictions/:id/cancel", async ({ request, params, principal }) => {
      if (!PREDICTION_ID.test(params.id)) throw new HttpError(400, "Invalid prediction ID");
      await assertOwner("prediction", params.id, principal.userId);
      return forwardJson(request, `/v1/predictions/${params.id}/cancel`, { method: "POST" });
    });
};
