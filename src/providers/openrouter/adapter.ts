import {
  type ProviderCompletion,
  type MeteredProviderResponse,
  type NormalizedUsage,
} from "../types";
import { ServerSentEventParser } from "../sse-parser";
import { openRouterRequestId, openRouterUsage } from "./usage";

export type OpenRouterRequest = {
  endpoint: string;
  body: Record<string, unknown>;
  apiKey: string;
  signal?: AbortSignal;
  headers?: HeadersInit;
};

export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenRouterAdapterOptions = {
  baseUrl?: string;
  fetch?: Fetch;
};

type ObservedUsage = {
  requestId: string | null;
  usage: NormalizedUsage | null;
  providerError: string | null;
};

const responseText = (chunks: Uint8Array[]) => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

const providerError = (value: unknown): string | null => {
  if (value === null || typeof value !== "object") return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error === null || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : "OpenRouter provider error";
};

class OpenRouterResponseObserver {
  private requestId: string | null = null;
  private usage: NormalizedUsage | null = null;
  private error: string | null = null;
  private readonly parser: ServerSentEventParser | null;

  constructor(private readonly eventStream: boolean) {
    this.parser = eventStream
      ? new ServerSentEventParser(({ data }) => {
          if (data === "[DONE]") return;
          try {
            this.observeValue(JSON.parse(data));
          } catch {
            // Invalid provider events are preserved byte-for-byte for the
            // caller and body search, but cannot be treated as billing facts.
          }
        })
      : null;
  }

  push(chunk: Uint8Array) {
    this.parser?.push(chunk);
  }

  finish(body: string): ObservedUsage {
    if (this.parser) {
      this.parser.finish();
    } else {
      try {
        this.observeValue(JSON.parse(body));
      } catch {
        this.error = "OpenRouter returned a non-JSON response";
      }
    }

    return {
      requestId: this.requestId,
      usage: this.usage,
      providerError: this.error,
    };
  }

  private observeValue(value: unknown) {
    this.requestId = openRouterRequestId(value) ?? this.requestId;
    this.usage = openRouterUsage(value) ?? this.usage;
    this.error = providerError(value) ?? this.error;
  }
}

const uncertainCompletion = (
  observation: ObservedUsage,
  body: string,
  bodyCapture: "complete" | "partial",
  reason?: string,
): ProviderCompletion => ({
  state: "uncertain",
  providerRequestId: observation.requestId,
  reason:
    reason ??
    observation.providerError ??
    "OpenRouter response ended without authoritative cost",
  responseBody: body,
  bodyCapture,
});

const meterResponse = (
  upstream: Response,
  requestBody: string,
): MeteredProviderResponse => {
  let settle: (completion: ProviderCompletion) => void = () => {};
  const completion = new Promise<ProviderCompletion>((resolve) => {
    settle = resolve;
  });
  const chunks: Uint8Array[] = [];
  const observer = new OpenRouterResponseObserver(
    upstream.headers.get("content-type")?.includes("text/event-stream") ??
      false,
  );

  if (!upstream.body) {
    const observation = observer.finish("");
    settle(uncertainCompletion(observation, "", "complete", "Empty response"));
    return { response: upstream, requestBody, completion };
  }

  const reader = upstream.body.getReader();
  let cancelled = false;
  let settled = false;
  const settleOnce = (result: ProviderCompletion) => {
    if (settled) return;
    settled = true;
    settle(result);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        // A pull may already be awaiting the upstream reader when the client
        // cancels. Its result must neither reach the closed controller nor
        // override the cancellation outcome.
        if (cancelled) return;
        if (!next.done) {
          const copy = next.value.slice();
          chunks.push(copy);
          observer.push(copy);
          controller.enqueue(next.value);
          return;
        }

        const captured = responseText(chunks);
        const observation = observer.finish(captured);
        if (observation.usage) {
          settleOnce({
            state: "complete",
            providerRequestId: observation.requestId,
            usage: observation.usage,
            responseBody: captured,
            bodyCapture: "complete",
          });
        } else {
          settleOnce(uncertainCompletion(observation, captured, "complete"));
        }
        controller.close();
      } catch (error) {
        if (cancelled) return;
        const captured = responseText(chunks);
        settleOnce(
          uncertainCompletion(
            observer.finish(captured),
            captured,
            "partial",
            error instanceof Error ? error.message : "Response stream failed",
          ),
        );
        controller.error(error);
      }
    },

    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
      const captured = responseText(chunks);
      const observation = observer.finish(captured);
      settleOnce({
        state: "cancelled",
        providerRequestId: observation.requestId,
        reason: typeof reason === "string" ? reason : "Client cancelled stream",
        responseBody: captured,
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

export class OpenRouterAdapter {
  private readonly baseUrl: string;
  private readonly fetchImplementation: Fetch;

  constructor(options: OpenRouterAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api").replace(
      /\/$/,
      "",
    );
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async execute(request: OpenRouterRequest): Promise<MeteredProviderResponse> {
    const requestBody = JSON.stringify(request.body);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${request.apiKey}`);
    headers.set("content-type", "application/json");

    const upstream = await this.fetchImplementation(
      `${this.baseUrl}/v1/${request.endpoint.replace(/^\//, "")}`,
      {
        method: "POST",
        headers,
        body: requestBody,
        signal: request.signal,
      },
    );

    return meterResponse(upstream, requestBody);
  }
}
