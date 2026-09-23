import type { Usd } from "../../billing/money";
import type { ProviderModule } from "../provider";

export const MISTRAL = "mistral";

/** Request fields that switch Mistral to its annotation pricing. */
const ANNOTATION_FIELDS = ["document_annotation_format", "bbox_annotation_format"] as const;

export const requestsAnnotations = (body: Record<string, unknown>) =>
  ANNOTATION_FIELDS.some((field) => body[field] !== undefined && body[field] !== null);

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

/** Processed pages at `pagePrice`, or null when the response reports no pages. */
export const ocrCost = (body: unknown, pagePrice: Usd): Usd | null => {
  const pages = ocrPageCount(body);
  return pages === null ? null : pagePrice.multiply(BigInt(pages));
};

/** No lookup: a pending OCR hold is released after the max age without a charge. */
export const mistralProvider: ProviderModule = { key: MISTRAL, reconcile: null };
