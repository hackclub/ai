import { describe, expect, test } from "bun:test";

import { requestAuthorization } from "./shared";

import { imagesFromChatResponse, parseImageGenerationRequest } from "./images";
import { isValidOcrDocument, ocrPageCount, redactOcrResponse, requestsAnnotations } from "./ocr";

describe("ocr helpers", () => {
  test("validates documents like the previous gateway", () => {
    expect(isValidOcrDocument({ type: "image_url", image_url: "https://x/y.png" })).toBeTrue();
    expect(isValidOcrDocument({ type: "image_url", image_url: "http://x/y.png" })).toBeFalse();
    expect(isValidOcrDocument({ type: "image_url", image_url: "data:image/png;base64,AAAA" })).toBeTrue();
    expect(isValidOcrDocument({ type: "document_url", document_url: "data:application/pdf;base64,AA" })).toBeTrue();
    expect(isValidOcrDocument({ type: "file", file_id: "" })).toBeFalse();
    expect(isValidOcrDocument({ type: "file", file_id: "f1" })).toBeTrue();
    expect(isValidOcrDocument("nope")).toBeFalse();
  });

  test("redacts page text and counts pages", () => {
    const body = {
      model: "mistral-ocr-latest",
      pages: [
        { index: 0, dimensions: { w: 1 }, markdown: "hello world", images: [{}, {}] },
        { index: 1, markdown: "" },
      ],
    };
    expect(JSON.parse(redactOcrResponse(body))).toEqual({
      model: "mistral-ocr-latest",
      pages: [
        { index: 0, dimensions: { w: 1 }, markdown_length: 11, images_count: 2 },
        { index: 1, markdown_length: 0, images_count: 0 },
      ],
    });
    expect(ocrPageCount(body)).toBe(2);
    expect(ocrPageCount({})).toBeNull();
    expect(JSON.parse(redactOcrResponse({ error: "x" }))).toEqual({ redacted: true });
  });
});

describe("ocr annotation pricing", () => {
  test("detects annotation requests, which Mistral bills at a higher page rate", () => {
    expect(requestsAnnotations({ document: {} })).toBeFalse();
    expect(requestsAnnotations({ document_annotation_format: null })).toBeFalse();
    expect(requestsAnnotations({ document_annotation_format: { type: "json_schema" } })).toBeTrue();
    expect(requestsAnnotations({ bbox_annotation_format: { type: "json_schema" } })).toBeTrue();
  });
});

describe("images helpers", () => {
  test("rejects unknown models and missing prompts", () => {
    expect(() => parseImageGenerationRequest({ prompt: "x", model: "img/nope" }, ["img/one"])).toThrow(
      "Unknown model",
    );
    expect(() => parseImageGenerationRequest({}, ["img/one"])).toThrow("prompt");
  });

  test("extracts images in the requested format", () => {
    const data = {
      choices: [
        {
          message: {
            images: [
              { image_url: { url: "data:image/png;base64,QUJD" } },
              { image_url: { url: "https://not-data" } },
            ],
          },
        },
      ],
    };
    expect(imagesFromChatResponse(data, "url")).toEqual([{ url: "data:image/png;base64,QUJD" }]);
    expect(imagesFromChatResponse(data, undefined)).toEqual([{ b64_json: "QUJD" }]);
  });
});

describe("requestAuthorization", () => {
  test("prefers the bearer header and only reads x-api-key when allowed", () => {
    const both = new Headers({ authorization: "Bearer a", "x-api-key": "b" });
    expect(requestAuthorization(both, { acceptApiKeyHeader: true })).toBe("Bearer a");

    const apiKeyOnly = new Headers({ "x-api-key": " sk-hc-v1-abc " });
    expect(requestAuthorization(apiKeyOnly)).toBeUndefined();
    expect(requestAuthorization(apiKeyOnly, { acceptApiKeyHeader: true })).toBe(
      "Bearer sk-hc-v1-abc",
    );
    expect(requestAuthorization(new Headers(), { acceptApiKeyHeader: true })).toBeUndefined();
  });
});
