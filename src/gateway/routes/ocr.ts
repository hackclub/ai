import { Elysia } from "elysia";

import { Usd } from "../../billing/money";
import { executeJsonProvider } from "../../providers/json-provider";
import { HttpError } from "../http-error";
import {
  authorizeProviderRequest,
  defaultRateLimiter,
  type MeteredRouteDependencies,
  parseJsonObject,
  runProviderRoute,
} from "./shared";

export type OcrRouteDependencies = MeteredRouteDependencies & {
  mistralApiKey: string | null;
  /** Fixed hold per request. */
  reservationUsd?: string;
  /** Mistral OCR price per processed page. */
  perPagePriceUsd?: string;
  /**
   * Price per page when the request asks for document or bbox annotations,
   * which Mistral bills at a higher rate than plain OCR.
   */
  annotationPagePriceUsd?: string;
  baseUrl?: string;
};

/** Request fields that switch Mistral to its annotation pricing. */
const ANNOTATION_FIELDS = ["document_annotation_format", "bbox_annotation_format"] as const;

export const requestsAnnotations = (body: Record<string, unknown>) =>
  ANNOTATION_FIELDS.some((field) => body[field] !== undefined && body[field] !== null);

const INVALID_DOCUMENT =
  "Invalid document. Provide a valid document with type 'image_url', 'document_url', or 'file'. URLs must use HTTPS or be valid base64-encoded data URIs.";

export const isValidOcrDocument = (document: unknown): boolean => {
  if (!document || typeof document !== "object") return false;
  const value = document as Record<string, unknown>;
  if (value.type === "image_url" && typeof value.image_url === "string") {
    return (
      value.image_url.startsWith("https://") ||
      /^data:image\/[^;]+;base64,/.test(value.image_url)
    );
  }
  if (value.type === "document_url" && typeof value.document_url === "string") {
    return (
      value.document_url.startsWith("https://") ||
      /^data:[^;]+;base64,/.test(value.document_url)
    );
  }
  if (value.type === "file" && typeof value.file_id === "string") {
    return value.file_id.length > 0;
  }
  return false;
};

/** Keeps page shape for analytics without storing extracted text. */
export const redactOcrResponse = (body: unknown): string => {
  if (!body || typeof body !== "object") return JSON.stringify({ redacted: true });
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value.pages)) return JSON.stringify({ redacted: true });
  return JSON.stringify({
    ...value,
    pages: value.pages.map((page: Record<string, unknown>) => ({
      index: page.index,
      dimensions: page.dimensions,
      markdown_length: typeof page.markdown === "string" ? page.markdown.length : 0,
      images_count: Array.isArray(page.images) ? page.images.length : 0,
    })),
  });
};

export const ocrPageCount = (body: unknown): number | null => {
  if (!body || typeof body !== "object") return null;
  const pages = (body as { pages?: unknown }).pages;
  return Array.isArray(pages) ? pages.length : null;
};

/** `POST /proxy/v1/ocr`, forwarded to Mistral and billed per page. */
export const ocrRoutes = (deps: OcrRouteDependencies) => {
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter();
  const reservation = Usd.parse(deps.reservationUsd ?? "0.05");
  const perPage = Usd.parse(deps.perPagePriceUsd ?? "0.001");
  const perAnnotatedPage = Usd.parse(deps.annotationPagePriceUsd ?? "0.003");
  const baseUrl = (deps.baseUrl ?? "https://api.mistral.ai").replace(/\/$/, "");

  return new Elysia({ prefix: "/proxy/v1" }).post("/ocr", async ({ request }) => {
    const rawBody = await request.text();
    const principal = await authorizeProviderRequest(deps, rateLimiter, request, rawBody);
    if (!deps.mistralApiKey) throw new HttpError(503, "OCR is not configured");

    const body = parseJsonObject(rawBody);
    if (!isValidOcrDocument(body.document)) throw new HttpError(400, INVALID_DOCUMENT);
    const model = typeof body.model === "string" ? body.model : "mistral-ocr-latest";
    const pagePrice = requestsAnnotations(body) ? perAnnotatedPage : perPage;
    const requestBody = JSON.stringify(body);

    const { metered } = await runProviderRoute(deps, request, principal, {
      provider: "mistral",
      endpoint: "ocr",
      model,
      estimatedCostUsd: reservation,
      execute: () =>
        executeJsonProvider({
          fetch: deps.fetch,
          url: `${baseUrl}/v1/ocr`,
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${deps.mistralApiKey}`,
            },
            body: requestBody,
            signal: request.signal,
          },
          extractCost: (response) => {
            const pages = ocrPageCount(response);
            return pages === null ? null : pagePrice.multiply(BigInt(pages));
          },
          redactResponseBody: redactOcrResponse,
        }),
    });
    return metered.response;
  });
};
