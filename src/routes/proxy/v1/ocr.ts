import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { env } from "../../../env";
import { isFeatureEnabled } from "../../../lib/posthog";
import { requireApiKey } from "../../../middleware/auth";
import { checkSpendingLimit } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import { type Ctx, logRequest, resolveUsage, standardLimiter } from "../shared";

const MISTRAL_API_URL = "https://api.mistral.ai";

type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: Record<string, unknown> };

type OCRDocument =
  | { type: "image_url"; image_url: string }
  | { type: "document_url"; document_url: string }
  | { type: "file"; file_id: string }
  | { type: "base64"; data: string; mime_type?: string };

type OCRRequest = {
  model?: string;
  document: OCRDocument;
  id?: string;
  pages?: number[];
  include_image_base64?: boolean;
  image_limit?: number;
  image_min_size?: number;
  table_format?: "markdown" | "html";
  extract_header?: boolean;
  extract_footer?: boolean;
  document_annotation_format?: ResponseFormat;
  bbox_annotation_format?: ResponseFormat;
};

const ALLOWED_OCR_MODELS = ["mistral-ocr-latest"];

const validateDocument = (doc: unknown): doc is OCRDocument => {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as Record<string, unknown>;
  if (d.type === "image_url" && typeof d.image_url === "string") {
    return d.image_url.startsWith("https://");
  }
  if (d.type === "document_url" && typeof d.document_url === "string") {
    return d.document_url.startsWith("https://");
  }
  if (d.type === "file" && typeof d.file_id === "string") {
    return d.file_id.length > 0;
  }
  if (d.type === "base64" && typeof d.data === "string") {
    return d.data.length > 0 && d.data.length < 70 * 1024 * 1024;
  }
  return false;
};

const redactResponse = (data: unknown): unknown => {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if (d.pages && Array.isArray(d.pages)) {
    return {
      ...d,
      pages: d.pages.map((p: Record<string, unknown>) => ({
        index: p.index,
        dimensions: p.dimensions,
        markdown_length: typeof p.markdown === "string" ? p.markdown.length : 0,
        images_count: Array.isArray(p.images) ? p.images.length : 0,
      })),
    };
  }
  return { redacted: true };
};

const ocr = new Hono<{ Variables: AppVariables }>();

ocr.post(
  "/ocr",
  requireApiKey,
  standardLimiter,
  checkSpendingLimit,
  async (c: Ctx) => {
    const user = c.get("user");

    const enabled = await isFeatureEnabled(user, "enable_ocr");
    if (!enabled) {
      throw new HTTPException(403, {
        message: "OCR is currently in closed beta. Contact support for access.",
      });
    }

    const start = Date.now();
    let body: OCRRequest;

    try {
      body = (await c.req.json()) as OCRRequest;
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }

    if (!validateDocument(body.document)) {
      throw new HTTPException(400, {
        message:
          "Invalid document. Provide a valid document with type 'image_url', 'document_url', 'file', or 'base64'. URLs must use HTTPS.",
      });
    }

    const model = ALLOWED_OCR_MODELS.includes(body.model || "")
      ? body.model!
      : "mistral-ocr-latest";

    try {
      const res = await fetch(`${MISTRAL_API_URL}/v1/ocr`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          document: body.document,
          id: body.id,
          pages: body.pages,
          include_image_base64: body.include_image_base64,
          image_limit: body.image_limit,
          image_min_size: body.image_min_size,
          table_format: body.table_format,
          extract_header: body.extract_header,
          extract_footer: body.extract_footer,
          document_annotation_format: body.document_annotation_format,
          bbox_annotation_format: body.bbox_annotation_format,
        }),
      });

      let data: unknown;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        throw new HTTPException(502, {
          message: "Invalid response from OCR service",
        });
      }

      await logRequest(
        c,
        { model, stream: false },
        redactResponse(data),
        resolveUsage(data),
        Date.now() - start,
      );

      return c.json(data, res.status as ContentfulStatusCode);
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }

      console.error("OCR proxy error:", error);

      await logRequest(
        c,
        { model, stream: false },
        { error: error instanceof Error ? error.message : "Unknown error" },
        { prompt: 0, completion: 0, total: 0, cost: 0 },
        Date.now() - start,
      );

      throw new HTTPException(500, { message: "Internal server error" });
    }
  },
);

export default ocr;
