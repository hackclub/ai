import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { ocrCost, requestsAnnotations } from "./provider";

const response = {
  model: "mistral-ocr-latest",
  pages: [
    { index: 0, markdown: "secret text", images: [{}, {}], dimensions: { width: 1, height: 2 } },
    { index: 1, markdown: "more", images: [] },
  ],
};

describe("mistral provider", () => {
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
});
