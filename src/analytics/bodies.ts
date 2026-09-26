import { S3Client } from "bun";

import type { BlobStoreConfig } from "../env";
import { ServerSentEventParser } from "../providers/sse-parser";

/**
 * Request and response bodies are compacted before they reach ClickHouse:
 * a streamed response is stored as the one message its chunks add up to, and
 * every base64 `data:` URL (images, audio, files) is moved to the blob store
 * and replaced by `blob:<mime>;<key>`.
 */

export const createBlobStore = (config: BlobStoreConfig) =>
  new S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

/** Marks a response body that was assembled from its event stream. */
export const ASSEMBLED_STREAM = "assembled_stream";

const DATA_URL = /data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})/g;

/** Shorter data URLs stay inline: the reference would save next to nothing. */
const MIN_BLOB_BASE64_CHARS = 1024;

export type BodyBlob = { key: string; type: string; bytes: Uint8Array };

/**
 * Keys are `<day the request happened>/<sha256 of the bytes>`, so a blob
 * resent on every turn of a conversation is stored once per day, and the
 * bucket's age-based expiry removes it with the rows that reference it.
 */
export const extractBlobs = (body: string, day: string, blobs: Map<string, BodyBlob>) =>
  body.replace(DATA_URL, (match, type: string, base64: string) => {
    // A capture cut mid-string leaves base64 that does not decode cleanly.
    if (base64.length < MIN_BLOB_BASE64_CHARS || base64.length % 4 !== 0) return match;
    const bytes = Buffer.from(base64, "base64");
    const key = `${day}/${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    if (!blobs.has(key)) blobs.set(key, { key, type, bytes });
    return `blob:${type};${key}`;
  });

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const events = (body: string) => {
  const parsed: Json[] = [];
  const parser = new ServerSentEventParser(({ data }) => {
    try {
      const value: unknown = JSON.parse(data);
      if (isRecord(value)) parsed.push(value);
    } catch {
      // `[DONE]`, or the last event of a truncated capture.
    }
  });
  parser.push(new TextEncoder().encode(body));
  parser.finish();
  return parsed;
};

/** Fields a stream sends in pieces; every other string is repeated whole, so it is replaced. */
const STREAMED_TEXT = new Set(["content", "reasoning", "refusal", "text", "summary", "arguments", "data"]);

/** Appends a streamed fragment: text concatenates, indexed array items merge, the rest is replaced. */
const mergeInto = (target: Json, fragment: Json) => {
  for (const [key, value] of Object.entries(fragment)) {
    const current = target[key];
    if (typeof value === "string" && typeof current === "string" && STREAMED_TEXT.has(key)) {
      target[key] = current + value;
    } else if (Array.isArray(value)) {
      const items = Array.isArray(current) ? current : [];
      for (const item of value) {
        const existing =
          isRecord(item) && typeof item.index === "number"
            ? items.find((candidate) => isRecord(candidate) && candidate.index === item.index && candidate.type === (item.type ?? candidate.type))
            : undefined;
        if (isRecord(existing) && isRecord(item)) mergeInto(existing, item);
        else items.push(isRecord(item) ? mergeInto({}, item) : item);
      }
      target[key] = items;
    } else if (isRecord(value)) {
      target[key] = mergeInto(isRecord(current) ? current : {}, value);
    } else if (value !== null || !(key in target)) {
      target[key] = value;
    }
  }
  return target;
};

const assembleChatCompletion = (chunks: Json[]) => {
  const completion: Json = { object: "chat.completion" };
  const choices: Json[] = [];
  for (const chunk of chunks) {
    for (const [key, value] of Object.entries(chunk)) {
      if (key === "choices" || key === "object" || value === null) continue;
      if (!(key in completion) || key === "usage" || key === "error") completion[key] = value;
    }
    if (!Array.isArray(chunk.choices)) continue;
    for (const delta of chunk.choices) {
      if (!isRecord(delta)) continue;
      const index = typeof delta.index === "number" ? delta.index : 0;
      let choice = choices.find((candidate) => candidate.index === index);
      if (!choice) {
        choice = { index, message: {} };
        choices.push(choice);
      }
      for (const [key, value] of Object.entries(delta)) {
        if (key === "delta" && isRecord(value)) mergeInto(choice.message as Json, value);
        else if (key !== "index" && (value !== null || !(key in choice))) choice[key] = value;
      }
    }
  }
  completion.choices = choices.sort((a, b) => (a.index as number) - (b.index as number));
  return completion;
};

const FINAL_RESPONSE_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete"]);

/**
 * The message a captured event stream adds up to, as JSON, or null when the
 * body is not a stream this knows how to read (it is then stored as is). The
 * chunks say which API they came from; rows without an endpoint rely on that.
 */
export const assembleStream = (body: string): string | null => {
  const parsed = events(body);
  if (parsed.length === 0) return null;
  if (parsed.some((event) => Array.isArray(event.choices))) {
    return JSON.stringify(assembleChatCompletion(parsed));
  }
  const final = parsed.findLast((event) => FINAL_RESPONSE_EVENTS.has(event.type as string));
  return final && isRecord(final.response) ? JSON.stringify(final.response) : null;
};

/** Some stored rows wrap the captured stream as `{"stream":true,"content":"<event stream>"}`. */
export const WRAPPED_STREAM_PREFIX = '{"stream":true,"content":';

const streamOf = (row: { streamed: boolean; response_body: string }) => {
  if (row.response_body.startsWith(WRAPPED_STREAM_PREFIX)) {
    try {
      const wrapped: unknown = JSON.parse(row.response_body);
      if (isRecord(wrapped) && typeof wrapped.content === "string") return wrapped.content;
    } catch {
      // A truncated capture; left as is.
    }
    return null;
  }
  return row.streamed ? row.response_body : null;
};

type BodyColumns = {
  occurred_at: string;
  streamed: boolean;
  attributes: Record<string, string>;
  request_body: string;
  response_body: string;
};

/** Compacts rows' bodies without side effects; returns the blobs they now reference. */
export const compactRows = <T extends BodyColumns>(rows: T[]) => {
  const blobs = new Map<string, BodyBlob>();
  const compacted = rows.map((row) => {
    const day = row.occurred_at.slice(0, 10);
    const attributes = { ...row.attributes };
    let response = row.response_body;
    const stream = attributes.response_body_format === ASSEMBLED_STREAM ? null : streamOf(row);
    if (stream !== null) {
      const assembled = assembleStream(stream);
      if (assembled !== null) {
        response = assembled;
        attributes.response_body_format = ASSEMBLED_STREAM;
      }
    }
    return {
      ...row,
      attributes,
      request_body: extractBlobs(row.request_body, day, blobs),
      response_body: extractBlobs(response, day, blobs),
    };
  });
  return { rows: compacted, blobs: [...blobs.values()] };
};

const UPLOAD_CONCURRENCY = 16;

/** Content-addressed, so a redelivered batch rewrites nothing. */
export const uploadBlobs = async (blobs: BodyBlob[], blobStore: S3Client) => {
  let next = 0;
  const upload = async () => {
    while (next < blobs.length) {
      const blob = blobs[next++]!;
      const file = blobStore.file(blob.key);
      if (!(await file.exists())) await file.write(blob.bytes, { type: blob.type });
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, blobs.length) }, upload));
};

/**
 * Compacts rows' bodies and uploads the blobs they reference before the rows
 * are written, so a stored reference always resolves.
 */
export const compactBodies = async <T extends BodyColumns>(rows: T[], blobStore: S3Client): Promise<T[]> => {
  const compacted = compactRows(rows);
  await uploadBlobs(compacted.blobs, blobStore);
  return compacted.rows;
};
