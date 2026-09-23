import { describe, expect, test } from "bun:test";

import { authenticateApiKey } from "../../auth/api-keys";
import { Usd } from "../../billing/money";
import type { ProviderCompletion } from "../../providers/types";
import { imagesFromChatResponse, parseImageGenerationRequest } from "./images";
import { isValidOcrDocument, ocrPageCount, redactOcrResponse, requestsAnnotations } from "./ocr";
import { type ProviderRouteInput, requestAuthorization, runProviderRoute } from "./shared";
import { testDatabase } from "../../test/database";
import { billingRecords, createTestAccount, onlyBillingRecord, testBilling, withFaults } from "./test-harness";

const { sql } = await testDatabase();

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

  /** A fresh account per test, authenticated through its real API key. */
  const setup = async () => {
    const account = await createTestAccount(sql, crypto.randomUUID());
    const principal = await authenticateApiKey(sql, `Bearer ${account.apiKey}`, { enforceIdv: false });
    return {
      ...testBilling(sql),
      account,
      principal,
      records: () => billingRecords(sql, account.accountId),
      record: () => onlyBillingRecord(sql, account.accountId),
    };
  };

  test("reserves under one request id and records the client ip", async () => {
    const { billing, settlements, principal, account, record, settled } = await setup();
    const { metered, requestId } = await runProviderRoute({ billing, settlements }, request, principal, routeInput());
    expect(metered.response.headers.get("x-request-id")).toBe(requestId);
    await settled();
    const finalized = await record();
    expect(finalized).toMatchObject({ requestId, state: "finalized", actualCostUsd: "0.010000000000" });
    expect(finalized.event).toMatchObject({
      account_id: account.accountId,
      user_id: principal.userId,
      api_key_id: principal.apiKeyId,
      attributes: { ip: "203.0.113.9" },
    });
  });

  test("maps InsufficientFundsError to a non-retryable 429 without dispatching", async () => {
    const { billing, settlements, principal, records } = await setup();
    const execute = async () => {
      throw new Error("execute must not run when the reservation fails");
    };
    // More than the account's $1 daily allowance, so the engine refuses it.
    const input = routeInput({ execute, estimatedCostUsd: Usd.parse("5") });
    const thrown = await runProviderRoute({ billing, settlements }, request, principal, input).catch((error: unknown) => error);
    expect(thrown).toMatchObject({
      status: 429,
      message: "Spending limit reached. Need a higher limit? hey@mahadk.com",
      headers: { "x-should-retry": "false" },
    });
    expect(await records()).toEqual([]);
  });

  test("reports a settlement failure through onSettlementError without failing the route", async () => {
    const { billing, settlements, principal, record, settled } = await setup();
    const settlementError = new Error("finalize exploded");
    const failing = withFaults(billing, {
      async finalize() {
        throw settlementError;
      },
    });
    const captured: Array<{ error: unknown; requestId: string }> = [];
    const { metered, requestId } = await runProviderRoute(
      { billing: failing, settlements, onSettlementError: (error, id) => captured.push({ error, requestId: id }) },
      request,
      principal,
      routeInput(),
    );
    expect(metered.response.status).toBe(200);
    await settled();
    await Promise.resolve();
    expect(captured).toEqual([{ error: settlementError, requestId }]);
    // The reservation stays held for the expiry sweeper and reconciliation.
    expect((await record()).state).toBe("reserved");
  });

  test("analytics read input.model at settlement, so Jev can upgrade it after the response", async () => {
    const { billing, settlements, principal, record, settled } = await setup();
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
    await runProviderRoute({ billing, settlements }, request, principal, input);
    await settled();
    expect((await record()).event).toMatchObject({ model: "changed" });
  });
});
