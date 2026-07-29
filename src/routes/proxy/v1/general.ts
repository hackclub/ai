import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { allowedImageModels, env } from "../../../env";
import { requireApiKey } from "../../../middleware/auth";
import { checkSpendingLimit, reserveCharge } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import {
  apiHeaders,
  type Ctx,
  estimateUpstreamCost,
  logRequest,
  MODEL_POOL,
  type ProxyReq,
  resolveModel,
  resolveUsage,
  SIZE_RATIOS,
  standardLimiter,
} from "../shared";

// Conservative fixed reservation for image generation. Real cost replaces
// this on log; the point is just to make a single oversized burst impossible
// when the user is already near their daily cap.
const IMAGE_GENERATION_RESERVATION = 0.25;
const UPSTREAM_HEADER_TIMEOUT_MS = 15_000;
const UPSTREAM_RETRY_ATTEMPTS = 2;

// HTTP status codes from upstream that are worth retrying (transient failures).
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

// Maximum delay between retries in milliseconds.
const MAX_RETRY_DELAY_MS = 5_000;

// Image-modality requests (text-to-image, image editing) routed through
// /chat/completions regularly exceed any reasonable header budget, since
// image models can take 10-30s to begin streaming a response. The header
// timeout guard is still valuable for text and embeddings, so we skip it
// when the request targets an image-capable model or explicitly asks for
// image output.
function isImageModalityRequest(body: {
  model?: string;
  modalities?: unknown;
  [k: string]: unknown;
}): boolean {
  if (body.model && allowedImageModels.includes(body.model)) return true;
  const modalities = body.modalities;
  return Array.isArray(modalities) && modalities.includes("image");
}

const general = new Hono<{ Variables: AppVariables }>();

/**
 * Parse the Retry-After header value into milliseconds.
 * Supports both delta-seconds and HTTP-date formats.
 * Returns null if the header is missing or unparseable.
 */
function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  // Delta-seconds: a plain integer
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }

  // HTTP-date: try parsing as a date
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    if (delay > 0) return Math.min(delay, MAX_RETRY_DELAY_MS);
  }

  return null;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a header timeout and automatic retries for transient failures.
 *
 * Retries on:
 * - Header timeout (our local 15s guard) on non-streaming requests
 * - Upstream 429 (rate limit), 502, 503, 504 (transient server errors)
 *
 * Does NOT retry:
 * - Streaming requests (body bytes may already be committed)
 * - 4xx errors other than 429 (client errors are not transient)
 * - Network errors other than our own timeout abort
 */
async function fetchWithRetries(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const isStreaming = init.body && typeof init.body !== "string";

  for (let attempt = 0; attempt <= UPSTREAM_RETRY_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      UPSTREAM_HEADER_TIMEOUT_MS,
    );

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);

      // Check if this is a retryable upstream error
      if (
        RETRYABLE_STATUS_CODES.has(res.status) &&
        attempt < UPSTREAM_RETRY_ATTEMPTS
      ) {
        // Don't retry streaming requests
        if (isStreaming) return res;

        // Respect Retry-After header if present (common on 429s)
        const retryAfter = parseRetryAfter(res) ?? 1000 * (attempt + 1);
        await sleep(retryAfter);
        continue;
      }

      return res;
    } catch (error) {
      clearTimeout(timeout);

      // Only retry on our own timeout abort, and only on non-streaming requests
      if (controller.signal.aborted) {
        if (attempt < UPSTREAM_RETRY_ATTEMPTS && !isStreaming) {
          // Exponential backoff: 1s, 2s
          await sleep(1000 * (attempt + 1));
          continue;
        }

        throw new HTTPException(504, {
          message: `Upstream did not return response headers within ${UPSTREAM_HEADER_TIMEOUT_MS}ms after ${UPSTREAM_RETRY_ATTEMPTS + 1} attempts`,
        });
      }

      // Re-throw all other errors (network errors, etc.)
      throw error;
    }
  }

  // Should not reach here, but TypeScript needs it
  throw new HTTPException(504, {
    message: "Upstream request failed after all retry attempts",
  });
}

async function handleProxy(c: Ctx, endpoint: string) {
  const start = Date.now();
  let body: ProxyReq = { model: "unknown" };

  try {
    body = (await c.req.json()) as ProxyReq;
    body.model = resolveModel(body.model, MODEL_POOL);
    body.user = `user_${c.get("user").id}`;
    body.usage = { include: true };

    await reserveCharge(c, await estimateUpstreamCost(body));

    const upstreamUrl = `${env.OPENAI_API_URL}/v1/${endpoint}`;
    const requestInit: RequestInit = {
      method: "POST",
      headers: apiHeaders(c),
      body: JSON.stringify(body),
    };

    // Image models take 10-30s+ to produce headers; skip the header
    // timeout entirely for those requests.
    const res = isImageModalityRequest(body)
      ? await fetch(upstreamUrl, requestInit)
      : await fetchWithRetries(upstreamUrl, requestInit);

    if (!body.stream && endpoint !== "embeddings") {
      // For non-streaming requests, we still need to keep Cloudflare alive
      // (524 timeout ~100s). We write leading whitespace — valid before any
      // JSON document per RFC 8259 — then flush the real payload once
      // OpenRouter finishes. This is "invisible streaming": the client still
      // receives a single, normal JSON response.
      const status = res.status as ContentfulStatusCode;

      return stream(c, async (s) => {
        c.header("Content-Type", "application/json");
        c.status(status);

        // Heartbeat: write a space every 30s to prevent Cloudflare 524
        const heartbeat = setInterval(async () => {
          try {
            await s.write(" ");
          } catch {
            clearInterval(heartbeat);
          }
        }, 10_000);

        try {
          const data = await res.json();
          clearInterval(heartbeat);
          await logRequest(
            c,
            body,
            data,
            resolveUsage(data),
            Date.now() - start,
          );
          await s.write(JSON.stringify(data));
        } catch (e) {
          clearInterval(heartbeat);
          throw e;
        }
      });
    }

    return stream(c, async (s) => {
      c.header("Content-Type", "text/event-stream");
      c.status(res.status as ContentfulStatusCode);
      const reader = res.body?.getReader(),
        decoder = new TextDecoder(),
        chunks: string[] = [];
      let usage = { prompt: 0, completion: 0, total: 0, cost: 0 };

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = decoder.decode(value, { stream: true });
        chunks.push(part);
        await s.write(value);

        for (const line of part
          .split("\n")
          .filter((l) => l.startsWith("data: "))) {
          const raw = line.slice(6).trim();
          if (raw !== "[DONE]")
            try {
              const chunkUsage = resolveUsage(JSON.parse(raw));
              if (chunkUsage.total > 0 || chunkUsage.cost > 0) {
                usage = chunkUsage;
              }
            } catch {}
        }
      }
      await logRequest(
        c,
        body,
        { stream: true, content: chunks.join("\n") },
        usage,
        Date.now() - start,
      );
    });
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`${endpoint} proxy error:`, error);

    await logRequest(
      c,
      body,
      { error: error instanceof Error ? error.message : "Unknown error" },
      { prompt: 0, completion: 0, total: 0, cost: 0 },
      duration,
    );

    if (error instanceof HTTPException) throw error;

    throw new HTTPException(500, { message: "Internal server error" });
  }
}

for (const ep of ["chat/completions", "responses", "embeddings"])
  general.post(
    `/${ep}`,
    requireApiKey,
    standardLimiter,
    checkSpendingLimit,
    (c) => handleProxy(c, ep),
  );

general.post(
  "/images/generations",
  requireApiKey,
  standardLimiter,
  checkSpendingLimit,
  async (c) => {
    const start = Date.now();
    const body = (await c.req.json()) as {
      prompt: string;
      model?: string;
      size?: string;
      response_format?: "url" | "b64_json";
    };
    const model = resolveModel(
      body.model || allowedImageModels[0],
      allowedImageModels,
    );

    await reserveCharge(c, IMAGE_GENERATION_RESERVATION);

    const res = await fetch(`${env.OPENAI_API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: apiHeaders(c),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: body.prompt }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: SIZE_RATIOS[body.size || ""] || "1:1" },
        user: `user_${c.get("user").id}`,
      }),
    });

    const data = (await res.json()) as {
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      usage?: Record<string, number>;
    };
    if (!res.ok) return c.json(data, res.status as ContentfulStatusCode);

    const images = (data.choices || []).flatMap((ch) =>
      (ch.message?.images || []).flatMap((img) => {
        const url = img.image_url?.url;
        return url?.startsWith("data:")
          ? [
              body.response_format === "url"
                ? { url }
                : { b64_json: url.split(",")[1] },
            ]
          : [];
      }),
    );

    await logRequest(
      c,
      { model, stream: false },
      data,
      resolveUsage(data),
      Date.now() - start,
    );
    return c.json({ created: Math.floor(Date.now() / 1000), data: images });
  },
);

export default general;
