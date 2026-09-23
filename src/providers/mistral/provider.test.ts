import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import {
  MISTRAL,
  mistralProvider,
  ocrCost,
  ocrPageCount,
  redactOcrResponse,
  requestsAnnotations,
} from "./provider";

const response = {
  model: "mistral-ocr-latest",
  pages: [
    { index: 0, markdown: "secret text", images: [{}, {}], dimensions: { width: 1, height: 2 } },
    { index: 1, markdown: "more", images: [] },
  ],
};

describe("mistral provider", () => {
  test("reserves under the mistral key and declares no lookup", () => {
    expect(MISTRAL).toBe("mistral");
    expect(mistralProvider).toEqual({ key: "mistral", reconcile: null });
  });

  test("ocrPageCount counts pages, null without a pages array", () => {
    expect(ocrPageCount(response)).toBe(2);
    expect(ocrPageCount({ pages: "x" })).toBeNull();
    expect(ocrPageCount(null)).toBeNull();
  });

  test("ocrCost bills each page at the page price", () => {
    expect(ocrCost(response, Usd.parse("0.001"))?.equals(Usd.parse("0.002"))).toBe(true);
    expect(ocrCost({ pages: [] }, Usd.parse("0.001"))?.equals(Usd.zero)).toBe(true);
    expect(ocrCost({}, Usd.parse("0.001"))).toBeNull();
  });

  test("requestsAnnotations detects either annotation format", () => {
    expect(requestsAnnotations({ document_annotation_format: {} })).toBe(true);
    expect(requestsAnnotations({ bbox_annotation_format: {} })).toBe(true);
    expect(requestsAnnotations({ document_annotation_format: null })).toBe(false);
    expect(requestsAnnotations({})).toBe(false);
  });

  test("redactOcrResponse keeps page shape without the extracted text", () => {
    const redacted = redactOcrResponse(response);
    expect(redacted).not.toContain("secret text");
    expect(JSON.parse(redacted)).toEqual({
      model: "mistral-ocr-latest",
      pages: [
        { index: 0, dimensions: { width: 1, height: 2 }, markdown_length: 11, images_count: 2 },
        { index: 1, markdown_length: 4, images_count: 0 },
      ],
    });
    expect(redactOcrResponse("text")).toBe(JSON.stringify({ redacted: true }));
    expect(redactOcrResponse({})).toBe(JSON.stringify({ redacted: true }));
  });
});
