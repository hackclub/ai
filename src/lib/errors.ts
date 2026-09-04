import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const DOCS_URL = "https://docs.ai.hackclub.com";

/**
 * Structured error body. The shape is deliberately OpenAI-compatible
 * (`error.message` / `error.type` / `error.code`) so that the OpenAI, OpenRouter
 * and Vercel AI SDKs surface a useful message instead of "undefined", and it
 * carries two extra machine-readable fields — `status` and `hint` — so an agent
 * can decide what to do next without scraping prose.
 */
export type ErrorEnvelope = {
  error: {
    message: string;
    type: string;
    code: string;
    status: number;
    hint: string;
    docs: string;
  };
  request_id?: string;
};

type ErrorDescriptor = {
  type: string;
  code: string;
  hint: string;
  docs: string;
};

const GENERIC: ErrorDescriptor = {
  type: "api_error",
  code: "api_error",
  hint: "Retry the request. If it keeps failing, ask in #hackclub-ai on the Hack Club Slack.",
  docs: DOCS_URL,
};

// Status -> stable machine-readable code plus a resolution hint. Keyed by
// status because that is all a thrown HTTPException reliably carries.
const DESCRIPTORS: Record<number, ErrorDescriptor> = {
  400: {
    type: "invalid_request_error",
    code: "invalid_request",
    hint: "Check the request body against the OpenAPI spec at /openapi.json.",
    docs: `${DOCS_URL}/api/chat-completions`,
  },
  401: {
    type: "authentication_error",
    code: "unauthorized",
    hint: "Send `Authorization: Bearer sk-hc-v1-...`. Create a key at https://ai.hackclub.com/keys.",
    docs: `${DOCS_URL}/guide/authentication`,
  },
  403: {
    type: "permission_error",
    code: "forbidden",
    hint: "Your account, model or client is not permitted to make this request. The message says which.",
    docs: `${DOCS_URL}/guide/rules`,
  },
  404: {
    type: "invalid_request_error",
    code: "not_found",
    hint: "Check /openapi.json for the endpoints that exist, or /llms.txt for a map of the site.",
    docs: DOCS_URL,
  },
  405: {
    type: "invalid_request_error",
    code: "method_not_allowed",
    hint: "Check /openapi.json for the methods this path accepts.",
    docs: DOCS_URL,
  },
  413: {
    type: "invalid_request_error",
    code: "payload_too_large",
    hint: "Send a smaller request body.",
    docs: DOCS_URL,
  },
  422: {
    type: "invalid_request_error",
    code: "unprocessable_entity",
    hint: "The body parsed but failed validation. Check /openapi.json for the expected schema.",
    docs: DOCS_URL,
  },
  429: {
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
    hint: "Back off and retry later. Limits are documented at https://docs.ai.hackclub.com/guide/rules.",
    docs: `${DOCS_URL}/guide/rules`,
  },
  500: GENERIC,
  502: {
    type: "api_error",
    code: "upstream_error",
    hint: "The upstream model provider failed. Retry with backoff; check https://ai.hackclub.com/up for service status.",
    docs: `${DOCS_URL}/api/healthcheck`,
  },
  503: {
    type: "api_error",
    code: "service_unavailable",
    hint: "The service is temporarily unavailable. Retry with backoff; check https://ai.hackclub.com/up for service status.",
    docs: `${DOCS_URL}/api/healthcheck`,
  },
  504: {
    type: "api_error",
    code: "upstream_timeout",
    hint: "The upstream model provider did not respond in time. Retry, or set a smaller max_tokens.",
    docs: `${DOCS_URL}/api/healthcheck`,
  },
};

const describeStatus = (status: number): ErrorDescriptor =>
  DESCRIPTORS[status] ?? GENERIC;

export const buildErrorEnvelope = (
  status: number,
  message: string,
  requestId?: string,
): ErrorEnvelope => {
  const descriptor = describeStatus(status);
  return {
    error: {
      message,
      type: descriptor.type,
      code: descriptor.code,
      status,
      hint: descriptor.hint,
      docs: descriptor.docs,
    },
    ...(requestId ? { request_id: requestId } : {}),
  };
};

// Everything under these prefixes is machine-facing, so it always answers in
// JSON regardless of what the client said it accepts.
const API_PREFIXES = ["/proxy", "/api", "/internal", "/up"];

const isApiPath = (path: string): boolean =>
  API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

/**
 * Decide the representation for an error. Browsers get HTML, API clients and
 * anything non-GET get JSON, and everyone else (curl, crawlers, agents sending
 * a bare wildcard Accept header) gets markdown they can actually read.
 */
type ErrorFormat = "json" | "html" | "markdown";

export const negotiateErrorFormat = (
  method: string,
  path: string,
  accept: string | undefined,
): ErrorFormat => {
  if (method !== "GET" && method !== "HEAD") return "json";
  if (isApiPath(path)) return "json";

  const header = (accept ?? "").toLowerCase();
  if (header.includes("application/json")) return "json";
  if (header.includes("text/html")) return "html";
  return "markdown";
};

const requestIdOf = (c: Context): string | undefined => {
  // Set by hono's requestId() middleware; falls back to the inbound header.
  const fromContext = (c as Context<{ Variables: { requestId?: string } }>).get(
    "requestId",
  );
  return fromContext ?? c.req.header("X-Request-Id");
};

const jsonError = (c: Context, status: number, message: string): Response =>
  c.json(
    buildErrorEnvelope(status, message, requestIdOf(c)),
    status as ContentfulStatusCode,
  );

/**
 * Short markdown body for a 404, so an agent that lands on a dead URL can
 * recover on its own instead of guessing.
 */
export const buildNotFoundMarkdown = (
  baseUrl: string,
  path: string,
): string => `# 404 — Not Found

\`${path}\` does not exist on ${baseUrl}.

## Where to look next

- [${baseUrl}/llms.txt](${baseUrl}/llms.txt) — map of this site, written for agents
- [${baseUrl}/openapi.json](${baseUrl}/openapi.json) — the complete HTTP API surface
- [${baseUrl}/sitemap.xml](${baseUrl}/sitemap.xml) — every indexable URL
- [${DOCS_URL}](${DOCS_URL}) — guides and API reference
- [${baseUrl}/](${baseUrl}/) — sign in with Hack Club to get an API key

## Common entry points

- \`GET ${baseUrl}/proxy/v1/models\` — list available models (no auth required)
- \`POST ${baseUrl}/proxy/v1/chat/completions\` — OpenAI-compatible chat completions
- \`GET ${baseUrl}/up\` — health check
`;

export type ErrorHandlerOptions = {
  baseUrl: string;
  /**
   * Renders the branded HTML 404 page. Must return a 404 response. Omitted in
   * tests and by any caller that has no views to render.
   */
  renderNotFoundPage?: (
    c: Context,
    path: string,
  ) => Response | Promise<Response>;
  /** Called for unhandled (non-HTTPException) errors, e.g. to report to Sentry. */
  onUnhandled?: (err: Error, c: Context) => void;
};

export const createNotFoundHandler =
  ({ baseUrl, renderNotFoundPage }: ErrorHandlerOptions): NotFoundHandler =>
  async (c) => {
    const path = c.req.path;
    const format = negotiateErrorFormat(
      c.req.method,
      path,
      c.req.header("Accept"),
    );
    const message = `No route matches ${c.req.method} ${path}`;

    if (format !== "json") {
      console.warn(`[404 ${c.req.method}] ${path}`);
    }

    if (format === "html" && renderNotFoundPage) {
      return await renderNotFoundPage(c, path);
    }

    if (format === "json") {
      return jsonError(c, 404, message);
    }

    return c.text(buildNotFoundMarkdown(baseUrl, path), 404, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  };

export const createErrorHandler =
  ({ onUnhandled }: ErrorHandlerOptions): ErrorHandler =>
  (err, c) => {
    if (err instanceof HTTPException) {
      // Deliberately ignores err.res: HTTPException's own response is
      // text/plain, and callers that attach a custom one only ever attach an
      // ad-hoc JSON shape. Both are replaced by the single envelope below.
      const status = err.status;
      const message = err.message || describeStatus(status).code;
      return jsonError(c, status, message);
    }

    console.error("Unhandled error:", err);
    onUnhandled?.(err, c);
    return jsonError(c, 500, "Internal server error");
  };
