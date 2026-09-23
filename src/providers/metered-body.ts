import { log } from "../log";
import { forwardableHeaders } from "./response-headers";
import type {
  MeteredProviderResponse,
  NormalizedUsage,
  ProviderCompletion,
} from "./types";

/**
 * Meters an upstream body: every byte passes through to the caller
 * unchanged, a copy is captured for analytics up to a cap, and the
 * completion resolves exactly once when the body ends, errors, or the
 * client cancels. Adapters supply only a `UsageReader` (how to read usage
 * from the bytes) and their policies as data. The completion mapping here is
 * the one place the billing meaning of an outcome is decided.
 */

export const isEventStream = (headers: Headers) =>
  headers.get("content-type")?.includes("text/event-stream") ?? false;

/** How the upstream body ended, as the reader sees it. */
export type BodyEnd =
  | { kind: "done" }
  | { kind: "error"; error: unknown }
  /** `drain` is set only under the drain policy: whether reading after the cancel reached the end. */
  | { kind: "cancelled"; reason: unknown; drain?: "finished" | "timed_out" | "failed" };

export type CapturedBody = {
  /** Decoded once, after the end; the chunks are released. */
  text: string;
  truncated: boolean;
  /** Upstream HTTP status. */
  status: number;
  /** Upstream headers. */
  headers: Headers;
  end: BodyEnd;
};

/** What the bytes proved. The primitive turns it into a ProviderCompletion. */
export type UsageVerdict = {
  usage: NormalizedUsage | null;
  providerRequestId: string | null;
  /** Why there is no usage; required when `usage` is null. */
  reason?: string;
  /** Replaces the stored analytics body (OCR redaction). */
  responseBody?: string;
  model?: string;
};

export type UsageReader = {
  /** Every upstream chunk, in order, before it is forwarded. */
  observe?: (chunk: Uint8Array) => void;
  /** Called exactly once. May be async (Replicate polls for final metrics). */
  read: (body: CapturedBody) => UsageVerdict | Promise<UsageVerdict>;
};

export type CancelPolicy =
  | { kind: "cancel-upstream" }
  /** The provider bills the whole response however early the client leaves; keep reading to see the cost. */
  | { kind: "drain"; timeoutMs: number };

export type MeterPolicy = {
  requestBody: string;
  reader: UsageReader;
  /** Analytics capture cap in bytes; null keeps everything (single JSON documents parsed whole). */
  maxCapturedBytes: number | null;
  /** "forwardable" filters through forwardableHeaders(); "upstream" passes them unchanged. */
  headers: "upstream" | "forwardable";
};

const isSuccess = (status: number) => status >= 200 && status < 300;

const MISSING_USAGE_REASON = "Provider response did not report usage";

const unbilledCapture = (body: CapturedBody) =>
  body.truncated ? "truncated" : body.end.kind === "done" ? "complete" : "partial";

/** The billing meaning of what the reader saw. */
const toCompletion = (body: CapturedBody, verdict: UsageVerdict): ProviderCompletion => {
  const common = {
    providerRequestId: verdict.providerRequestId,
    responseBody: verdict.responseBody ?? body.text,
    ...(verdict.model === undefined ? {} : { model: verdict.model }),
  };
  if (verdict.usage) {
    // Usage wins whatever the status: the provider says it charged this.
    return {
      ...common,
      state: "complete",
      usage: verdict.usage,
      bodyCapture: body.truncated ? "truncated" : "complete",
    };
  }
  const bodyCapture = unbilledCapture(body);
  if (!isSuccess(body.status)) {
    return { ...common, state: "provider_error", bodyCapture };
  }
  return {
    ...common,
    state: "uncertain",
    reason: verdict.reason ?? MISSING_USAGE_REASON,
    bodyCapture,
  };
};

const concat = (chunks: Uint8Array[]) => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * The capture buffer and the settle-once guard shared by both entry points.
 * `settle` runs the reader exactly once; the completion never rejects.
 */
const meter = (upstream: Response, reader: UsageReader, maxCapturedBytes: number | null) => {
  const { promise: completion, resolve } = Promise.withResolvers<ProviderCompletion>();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let settled = false;

  /** Observes a copy of the chunk and captures it unless the cap was hit (sticky). */
  const take = (chunk: Uint8Array) => {
    const copy = chunk.slice();
    reader.observe?.(copy);
    if (
      !truncated &&
      (maxCapturedBytes === null || capturedBytes + copy.byteLength <= maxCapturedBytes)
    ) {
      chunks.push(copy);
      capturedBytes += copy.byteLength;
    } else {
      truncated = true;
    }
  };

  const settle = (end: BodyEnd) => {
    if (settled) return;
    settled = true;
    // Decoded once and the chunks released: Replicate may hold the
    // settlement for its whole polling window.
    const text = new TextDecoder().decode(concat(chunks));
    chunks.length = 0;
    const body: CapturedBody = {
      text,
      truncated,
      status: upstream.status,
      headers: upstream.headers,
      end,
    };
    void (async () => {
      try {
        resolve(toCompletion(body, await reader.read(body)));
      } catch (error) {
        // A reader bug must still settle the reservation: held for
        // reconciliation, whatever the status.
        log.error({ err: error }, "usage reader failed");
        resolve({
          state: "uncertain",
          providerRequestId: null,
          reason: "completion_rejected",
          responseBody: text,
          bodyCapture: unbilledCapture(body),
        });
      }
    })();
  };

  return { completion, take, settle };
};

const responseHeaders = (upstream: Response, policy: MeterPolicy["headers"]) =>
  policy === "forwardable" ? forwardableHeaders(upstream.headers) : upstream.headers;

/** Pass-through: bytes reach the caller as they arrive. */
export function meterStreamed(
  upstream: Response,
  policy: MeterPolicy & { onCancel: CancelPolicy },
): MeteredProviderResponse {
  const { completion, take, settle } = meter(upstream, policy.reader, policy.maxCapturedBytes);
  const { requestBody } = policy;

  if (!upstream.body) {
    settle({ kind: "done" });
    return { response: upstream, requestBody, completion };
  }

  const reader = upstream.body.getReader();
  let cancelled = false;
  // The read a pull is awaiting, so a drain can take it over instead of
  // reading concurrently.
  let inFlight: ReturnType<typeof reader.read> | null = null;

  const drain = async (reason: unknown, timeoutMs: number) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel("drain timeout").catch(() => {});
    }, timeoutMs);
    let pending = inFlight;
    try {
      for (;;) {
        const next = await (pending ?? reader.read());
        pending = null;
        if (next.done) break;
        take(next.value);
      }
      settle({ kind: "cancelled", reason, drain: timedOut ? "timed_out" : "finished" });
    } catch {
      settle({ kind: "cancelled", reason, drain: timedOut ? "timed_out" : "failed" });
    } finally {
      clearTimeout(timer);
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const read = reader.read();
        inFlight = read;
        const next = await read;
        inFlight = null;
        // A pull may already be awaiting the upstream reader when the client
        // cancels. Its result must neither reach the cancelled controller nor
        // decide the outcome: the cancel (or the drain) owns it.
        if (cancelled) return;
        if (next.done) {
          settle({ kind: "done" });
          controller.close();
          return;
        }
        take(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        inFlight = null;
        if (cancelled) return;
        settle({ kind: "error", error });
        controller.error(error);
      }
    },

    async cancel(reason) {
      cancelled = true;
      if (policy.onCancel.kind === "drain") {
        // The client is gone; keep reading in the background so the cost
        // can still be seen, without holding up the client's cancel.
        void drain(reason, policy.onCancel.timeoutMs);
        return;
      }
      // The upstream may already be gone (aborted fetch, closed socket). A
      // rejected cancel must not leave `completion` unsettled, or the
      // reservation would only ever close by expiry.
      await reader.cancel(reason).catch(() => {});
      settle({ kind: "cancelled", reason });
    },
  });

  return {
    response: new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream, policy.headers),
    }),
    requestBody,
    completion,
  };
}

/**
 * Request-response: reads the whole body before returning. A body read
 * error rejects, so the caller's reservation is released.
 */
export async function meterBuffered(
  upstream: Response,
  policy: Omit<MeterPolicy, "maxCapturedBytes">,
): Promise<MeteredProviderResponse> {
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const { completion, take, settle } = meter(upstream, policy.reader, null);
  take(bytes);
  settle({ kind: "done" });
  await completion;
  return {
    response: new Response(bytes, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream, policy.headers),
    }),
    requestBody: policy.requestBody,
    completion,
  };
}
