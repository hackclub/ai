import * as Sentry from "@sentry/bun";
import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";

import { db } from "../../db";
import { requestLogs } from "../../db/schema";
import {
  allowedEmbeddingModels,
  allowedImageModels,
  allowedLanguageModels,
} from "../../env";
import { fetchLanguageModels, openRouterHeaders } from "../../lib/models";
import { captureEvent } from "../../lib/posthog";
import { releasePendingCharge } from "../../middleware/limits";
import type { AppVariables } from "../../types";

export type Ctx = Context<{ Variables: AppVariables }>;

const SAFE_HEADERS = [
  "user-agent",
  "content-type",
  "accept",
  "accept-language",
  "origin",
  "referer",
];

const sanitizeHeaders = (headers: Headers): Record<string, string> => {
  const safe: Record<string, string> = {};
  for (const key of SAFE_HEADERS) {
    const value = headers.get(key);
    if (value) safe[key] = value;
  }
  return safe;
};

export type ProxyReq = {
  model: string;
  stream?: boolean;
  user?: string;
  usage?: { include: boolean };
  messages?: unknown;
  input?: unknown;
  prompt?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
};

// RFC 2397 data URLs may carry mediatype parameters before ";base64"
// (e.g. data:image/svg+xml;charset=utf-8;base64,...) and the scheme and
// encoding are case-insensitive. The header ends at the first comma, so
// matching anything between "data:" and ";base64," is linear and safe.
const DATA_URL_BASE64_REGEX = /^data:[^,]*;base64,/i;

// Media inputs are billed as tokens at the model's per-token rates. These
// conversion rates are the Google-published Gemini tokenization rates.
const VIDEO_TOKENS_PER_SECOND = 263;
const AUDIO_TOKENS_PER_SECOND = 32;
// Conservative flat per-image estimate; Gemini tiling charges 258 tokens
// minimum and a few thousand for large tiled images.
const TOKENS_PER_IMAGE = 1_024;
// Conservative bitrates used to derive duration from blob size; both are
// deliberately low so duration (and therefore tokens) is over-estimated.
const VIDEO_BYTES_PER_SECOND = 65_536; // ~0.5 Mbps
const AUDIO_BYTES_PER_SECOND = 12_288; // ~96 kbps
// Cap per media part so a pathological blob can't reserve the whole cap.
const MAX_MEDIA_SECONDS = 600;
// Media referenced by http(s) URL has unknown size; assume a fixed amount.
const URL_MEDIA_SECONDS = 60;

type MediaKind = "video" | "audio" | "image";

type MediaStats = {
  images: number;
  videoSeconds: number;
  audioSeconds: number;
};

// Extract the media kind and base64 payload length from a data URL using
// lengths only — the blob is never decoded or copied. Returns null for
// anything that isn't a base64 data URL.
const parseDataUrl = (
  value: string,
): { kind: MediaKind; b64Chars: number } | null => {
  if (!DATA_URL_BASE64_REGEX.test(value)) return null;
  const comma = value.indexOf(",");
  const mime = value.slice(5, value.indexOf(";")).toLowerCase();
  const kind: MediaKind = mime.startsWith("video/")
    ? "video"
    : mime.startsWith("audio/")
      ? "audio"
      : "image";
  return { kind, b64Chars: value.length - comma - 1 };
};

// base64 length -> raw bytes; accumulate as seconds (video/audio) or a
// flat image count, capping the duration of each individual part.
const addBlob = (
  kind: MediaKind,
  b64Chars: number,
  stats: MediaStats,
): void => {
  const rawBytes = Math.floor((b64Chars * 3) / 4);
  if (kind === "video") {
    stats.videoSeconds += Math.min(
      rawBytes / VIDEO_BYTES_PER_SECOND,
      MAX_MEDIA_SECONDS,
    );
  } else if (kind === "audio") {
    stats.audioSeconds += Math.min(
      rawBytes / AUDIO_BYTES_PER_SECOND,
      MAX_MEDIA_SECONDS,
    );
  } else {
    stats.images += 1;
  }
};

// Media given as a data URL (blob length) or an http(s) URL (unknown
// size -> fixed assumption).
const addUrlOrBlob = (
  value: string,
  defaultKind: MediaKind,
  stats: MediaStats,
): void => {
  const info = parseDataUrl(value);
  if (info) {
    addBlob(info.kind, info.b64Chars, stats);
    return;
  }
  if (/^https?:\/\//i.test(value)) {
    if (defaultKind === "video") stats.videoSeconds += URL_MEDIA_SECONDS;
    else if (defaultKind === "audio") stats.audioSeconds += URL_MEDIA_SECONDS;
    else stats.images += 1;
  }
};

// input_audio / input_video parts: the data field is usually raw base64
// (no data-URL prefix), but data URLs and http(s) references are accepted.
const addAudioVideoPart = (
  value: unknown,
  kind: MediaKind,
  stats: MediaStats,
): void => {
  let data: unknown = value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    data = (value as Record<string, unknown>).data;
  }
  if (typeof data !== "string") return;
  const info = parseDataUrl(data);
  if (info) {
    addBlob(info.kind, info.b64Chars, stats);
  } else if (/^https?:\/\//i.test(data)) {
    if (kind === "video") stats.videoSeconds += URL_MEDIA_SECONDS;
    else stats.audioSeconds += URL_MEDIA_SECONDS;
  } else {
    addBlob(kind, data.length, stats);
  }
};

// input_file parts (Responses API / Google file parts): classify via the
// data-URL MIME when available; unknown sizes fall back to the per-image
// assumption.
const collectFileStats = (value: unknown, stats: MediaStats): void => {
  if (typeof value === "string") {
    addUrlOrBlob(value, "image", stats);
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const file = value as Record<string, unknown>;
  for (const field of ["file_data", "url", "file_uri"]) {
    const inner = file[field];
    if (typeof inner === "string") {
      addUrlOrBlob(inner, "image", stats);
      return;
    }
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      collectFileStats(inner, stats);
      return;
    }
  }
};

// Collect per-media-part token stats over the estimation target without
// copying blobs (reads string lengths only) and without mutating the body.
const collectMediaStats = (value: unknown, stats: MediaStats): void => {
  if (typeof value === "string") {
    const info = parseDataUrl(value);
    if (info) addBlob(info.kind, info.b64Chars, stats);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaStats(item, stats);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (key === "b64_json" && typeof v === "string") {
      // OpenAI image input/output convention: raw base64 image data.
      stats.images += 1;
    } else if (key === "input_audio" || key === "input_video") {
      addAudioVideoPart(v, key === "input_audio" ? "audio" : "video", stats);
    } else if (key === "image_url" || key === "video_url") {
      const url =
        typeof v === "string"
          ? v
          : v !== null && typeof v === "object" && !Array.isArray(v)
            ? (v as Record<string, unknown>).url
            : undefined;
      if (typeof url === "string") {
        addUrlOrBlob(url, key === "image_url" ? "image" : "video", stats);
      }
    } else if (key === "input_file") {
      collectFileStats(v, stats);
    } else {
      collectMediaStats(v, stats);
    }
  }
};

// Replace base64 media blobs (data URLs, b64_json fields, input_audio
// payloads) with a short placeholder so they aren't counted as tokens in
// the cost estimate. Transforms the value via a recursive walk over
// shallow-copied containers, so the original body is never mutated.
const sanitizeForEstimation = (value: unknown): unknown => {
  if (typeof value === "string") {
    return DATA_URL_BASE64_REGEX.test(value) ? "[media]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForEstimation(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Null-prototype copy: an own "__proto__" key (kept by JSON.parse)
    // becomes a plain property instead of hitting the prototype setter.
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (key === "b64_json" && typeof v === "string") {
        result[key] = "[media]";
      } else if (
        key === "input_audio" &&
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v)
      ) {
        const audio = sanitizeForEstimation(v) as Record<string, unknown>;
        if (typeof audio.data === "string") audio.data = "[media]";
        result[key] = audio;
      } else {
        result[key] = sanitizeForEstimation(v);
      }
    }
    return result;
  }
  return value;
};

// Conservative upper-bound estimate of what a chat / responses / embeddings
// call will cost, used to reserve capacity against the user's daily limit
// BEFORE the upstream request is dispatched. We err on the high side: it's
// fine to over-reserve (the real cost replaces the estimate on log), but
// under-reserving lets users blow past their cap on a single big request or
// a burst of concurrent requests.
export async function estimateUpstreamCost(body: ProxyReq): Promise<number> {
  try {
    const models = await fetchLanguageModels();
    const model = models.data.find((m) => m.id === body.model);
    if (!model?.pricing) return 0.05;

    const promptPrice = parseFloat(model.pricing.prompt || "0");
    const completionPrice = parseFloat(model.pricing.completion || "0");

    // Rough input-token estimate from the serialized payload. 3 chars/token
    // is intentionally conservative (most tokenizers are ~4 chars/token).
    // Base64 media blobs are replaced with "[media]" first so a large
    // image/video/audio attachment doesn't inflate the token count; media
    // is priced separately below via collectMediaStats.
    const target = body.messages ?? body.input ?? body.prompt ?? body;
    const raw = JSON.stringify(target);
    // Fast path: skip both the sanitization walk and the media walk for
    // text-only payloads. A false positive only costs an extra walk, never
    // an incorrect estimate. Case-insensitive so uppercase "DATA:" URLs
    // aren't missed.
    const hasMedia =
      /data:|b64_json|input_audio|input_video|input_file|image_url|video_url/i.test(
        raw,
      );
    const stats: MediaStats = { images: 0, videoSeconds: 0, audioSeconds: 0 };
    const payload = hasMedia
      ? JSON.stringify(sanitizeForEstimation(target))
      : raw;
    if (hasMedia) collectMediaStats(target, stats);
    const inputTokens = Math.ceil(payload.length / 3);

    // OpenRouter's pricing.image / pricing.audio are per-TOKEN rates (not
    // per-image / per-second); fall back to the prompt rate when absent.
    const imageRate = parseFloat(model.pricing.image ?? "");
    const audioRate = parseFloat(model.pricing.audio ?? "");
    const imagePrice = Number.isNaN(imageRate) ? promptPrice : imageRate;
    const audioPrice = Number.isNaN(audioRate) ? promptPrice : audioRate;

    const imageTokens = stats.images * TOKENS_PER_IMAGE;
    const audioTokens = stats.audioSeconds * AUDIO_TOKENS_PER_SECOND;
    const videoTokens = stats.videoSeconds * VIDEO_TOKENS_PER_SECOND;

    const requestedMax =
      body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
    const modelMax =
      model.top_provider?.max_completion_tokens ?? model.context_length ?? 8192;
    // If the caller didn't pin max_tokens, assume they could consume up to
    // the model's full completion window.
    const outputTokens = requestedMax ?? modelMax;

    return (
      inputTokens * promptPrice +
      imageTokens * imagePrice +
      audioTokens * audioPrice +
      videoTokens * promptPrice +
      outputTokens * completionPrice
    );
  } catch {
    return 0.05;
  }
}

export const MODEL_POOL = [
  ...allowedLanguageModels,
  ...allowedImageModels,
  ...allowedEmbeddingModels,
];

export const SIZE_RATIOS: Record<string, string> = {
  "1024x1024": "1:1",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
  "512x512": "1:1",
  "256x256": "1:1",
};

const limiter = (limit: number) =>
  rateLimiter({
    limit,
    windowMs: 30 * 60 * 1000,
    keyGenerator: (c: Ctx) => c.get("user")?.id || c.get("ip"),
  });

export const standardLimiter = limiter(750);
export const moderationsLimiter = limiter(300);

type Usage = {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost?: number;
  cost_details?: { upstream_inference_cost?: number };
};

export const resolveUsage = (data: unknown) => {
  const u =
    (
      data as {
        usage?: Usage;
        response?: { usage?: Usage };
      }
    )?.usage ||
    (data as { response?: { usage?: Usage } })?.response?.usage ||
    {};
  return {
    prompt: u.prompt_tokens || u.input_tokens || 0,
    completion: u.completion_tokens || u.output_tokens || 0,
    total: u.total_tokens || 0,
    cost: u.cost || u.cost_details?.upstream_inference_cost || 0,
  };
};

export const apiHeaders = (c: Ctx) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${c.get("openrouterKey")}`,
  ...openRouterHeaders,
});

// export const resolveModel = (model: string, pool: string[]) =>
//   pool.includes(model) ? model : pool[0];
export const resolveModel = (model: string, pool: string[]) => model;

export const logRequest = async (
  c: Ctx,
  body: ProxyReq | Record<string, unknown>,
  resBody: unknown,
  usage: ReturnType<typeof resolveUsage>,
  ms: number,
) => {
  const user = c.get("user");
  const model = (body as ProxyReq).model || "unknown";

  Sentry.startSpan({ name: "db.log" }, () =>
    db
      .insert(requestLogs)
      .values({
        apiKeyId: c.get("apiKey").id,
        userId: user.id,
        slackId: user.slackId,
        model,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        cost: String(usage.cost),
        request: body,
        response: resBody,
        duration: ms,
        headers: sanitizeHeaders(c.req.raw.headers),
        ip: c.get("ip"),
        timestamp: new Date(),
      })
      .catch((e) => console.error("Logging failed:", e)),
  );

  captureEvent(user, "api_request", {
    model,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    totalTokens: usage.total,
    cost: usage.cost,
    duration: ms,
  });

  await releasePendingCharge(c);
};
