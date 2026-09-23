import { describe, expect, test } from "bun:test";

import type { AuthenticatedPrincipal } from "../../auth/api-keys";
import { InsufficientFundsError } from "../../billing/errors";
import { Usd } from "../../billing/money";
import type { ProviderCompletion } from "../../providers/types";
import { imagesFromChatResponse, parseImageGenerationRequest } from "./images";
import { isValidOcrDocument, ocrPageCount, redactOcrResponse, requestsAnnotations } from "./ocr";
import { type ProviderRouteInput, requestAuthorization, runProviderRoute } from "./shared";
import { fakeBilling } from "./test-harness";

test.each([
  [{ type: "image_url", image_url: "https://x/y.png" }, true],
  [{ type: "image_url", image_url: "http://x/y.png" }, false],
  [{ type: "image_url", image_url: "data:image/png;base64,AAAA" }, true],
  [{ type: "document_url", document_url: "data:application/pdf;base64,AA" }, true],
  [{ type: "file", file_id: "" }, false],
  [{ type: "file", file_id: "f1" }, true],
  ["nope", false],
])("isValidOcrDocument(%j) is %p", (document, valid) => {
  expect(isValidOcrDocument(document)).toBe(valid);
});

test("redacts OCR page text and counts pages", () => {
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

test("detects OCR annotation requests, which Mistral bills at a higher page rate", () => {
  expect(requestsAnnotations({ document: {} })).toBeFalse();
  expect(requestsAnnotations({ document_annotation_format: null })).toBeFalse();
  expect(requestsAnnotations({ document_annotation_format: { type: "json_schema" } })).toBeTrue();
  expect(requestsAnnotations({ bbox_annotation_format: { type: "json_schema" } })).toBeTrue();
});

test("image generation rejects unknown models and missing prompts", () => {
  expect(() => parseImageGenerationRequest({ prompt: "x", model: "img/nope" }, ["img/one"])).toThrow(
    "Unknown model",
  );
  expect(() => parseImageGenerationRequest({}, ["img/one"])).toThrow("prompt");
});

test("extracts generated images in the requested format", () => {
  const data = {
    choices: [
      {
        message: {
          images: [{ image_url: { url: "data:image/png;base64,QUJD" } }, { image_url: { url: "https://not-data" } }],
        },
      },
    ],
  };
  expect(imagesFromChatResponse(data, "url")).toEqual([{ url: "data:image/png;base64,QUJD" }]);
  expect(imagesFromChatResponse(data, undefined)).toEqual([{ b64_json: "QUJD" }]);
});

test("requestAuthorization prefers the bearer header and only reads x-api-key when allowed", () => {
  const both = new Headers({ authorization: "Bearer a", "x-api-key": "b" });
  expect(requestAuthorization(both, { acceptApiKeyHeader: true })).toBe("Bearer a");

  const apiKeyOnly = new Headers({ "x-api-key": " sk-hc-v1-abc " });
  expect(requestAuthorization(apiKeyOnly)).toBeUndefined();
  expect(requestAuthorization(apiKeyOnly, { acceptApiKeyHeader: true })).toBe("Bearer sk-hc-v1-abc");
  expect(requestAuthorization(new Headers(), { acceptApiKeyHeader: true })).toBeUndefined();
});

describe("runProviderRoute", () => {
  const principal: AuthenticatedPrincipal = { userId: "user-1", apiKeyId: "key-1", billingAccountId: "account-1" };
  const completion: ProviderCompletion = {
    state: "complete",
    providerRequestId: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: Usd.parse("0.01") },
    responseBody: "ok",
    bodyCapture: "complete",
  };
  const routeInput = (overrides: Partial<ProviderRouteInput> = {}): ProviderRouteInput => ({
    provider: "test",
    endpoint: "test/endpoint",
    model: "test-model",
    estimatedCostUsd: Usd.parse("0.01"),
    execute: async () => ({ response: new Response("ok"), requestBody: "{}", completion: Promise.resolve(completion) }),
    ...overrides,
  });
  const request = new Request("http://gateway.test/x", { headers: { "cf-connecting-ip": "203.0.113.9" } });

  test("reserves under one request id and records the client ip", async () => {
    const { billing, reserves, finalizes, settled } = fakeBilling();
    const { metered, requestId } = await runProviderRoute({ billing }, request, principal, routeInput());
    expect(metered.response.headers.get("x-request-id")).toBe(requestId);
    await settled();
    expect(reserves()[0]).toMatchObject({ requestId, accountId: "account-1" });
    expect(finalizes()[0]?.analytics?.attributes).toMatchObject({ ip: "203.0.113.9" });
  });

  test("maps InsufficientFundsError to a non-retryable 429 without dispatching", async () => {
    const { billing } = fakeBilling({
      async reserve() {
        throw new InsufficientFundsError();
      },
    });
    const execute = async () => {
      throw new Error("execute must not run when the reservation fails");
    };
    const thrown = await runProviderRoute({ billing }, request, principal, routeInput({ execute })).catch(
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({
      status: 429,
      message: "Spending limit reached. Need a higher limit? hey@mahadk.com",
      headers: { "x-should-retry": "false" },
    });
  });

  test("reports a settlement failure through onSettlementError without failing the route", async () => {
    const settlementError = new Error("finalize exploded");
    const { billing, settled } = fakeBilling({
      async finalize() {
        throw settlementError;
      },
    });
    const captured: Array<{ error: unknown; requestId: string }> = [];
    const { metered, requestId } = await runProviderRoute(
      { billing, onSettlementError: (error, id) => captured.push({ error, requestId: id }) },
      request,
      principal,
      routeInput(),
    );
    expect(metered.response.status).toBe(200);
    await settled();
    await Promise.resolve();
    expect(captured).toEqual([{ error: settlementError, requestId }]);
  });

  test("analytics read input.model at settlement, so Jev can upgrade it after the response", async () => {
    const { billing, finalizes, settled } = fakeBilling();
    const input: ProviderRouteInput = routeInput({
      execute: async () => ({
        response: new Response("ok"),
        requestBody: "{}",
        completion: Promise.resolve(completion).then((value) => {
          input.model = "changed";
          return value;
        }),
      }),
    });
    await runProviderRoute({ billing }, request, principal, input);
    await settled();
    expect(finalizes()[0]?.analytics?.model).toBe("changed");
  });
});
