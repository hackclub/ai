import { describe, expect, test } from "bun:test";

import type { AuthenticatedPrincipal } from "../../auth/api-keys";
import type { FinalizeInput, Reservation, ReserveInput } from "../../billing/engine";
import { InsufficientFundsError } from "../../billing/errors";
import { Usd } from "../../billing/money";
import { HttpError } from "../http-error";
import type { BillingLifecycle } from "../metered-request";
import type { MeteredProviderResponse, ProviderCompletion } from "../../providers/types";
import { requestAuthorization, runProviderRoute } from "./shared";

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

describe("runProviderRoute", () => {
  type Call =
    | { method: "reserve"; input: ReserveInput }
    | { method: "finalize"; input: FinalizeInput }
    | { method: "release"; requestId: string }
    | { method: "markPendingReconciliation"; requestId: string; reason: string };

  const reservationFor = (requestId: string, state: Reservation["state"]): Reservation => ({
    id: "reservation-1",
    requestId,
    accountId: "account-1",
    provider: "test",
    providerRequestId: null,
    state,
    estimatedCostUsd: "0.010000000000",
    actualCostUsd: null,
    unfundedCostUsd: "0.000000000000",
    expiresAt: new Date(0),
  });

  const fakeBilling = (overrides: Partial<BillingLifecycle> = {}) => {
    const calls: Call[] = [];
    let settled: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const billing: BillingLifecycle = {
      async reserve(input) {
        calls.push({ method: "reserve", input });
        return reservationFor(input.requestId, "reserved");
      },
      async finalize(input) {
        calls.push({ method: "finalize", input });
        settled();
        return reservationFor(input.requestId, "finalized");
      },
      async release(requestId) {
        calls.push({ method: "release", requestId });
        settled();
        return reservationFor(requestId, "released");
      },
      async markPendingReconciliation(requestId, reason) {
        calls.push({ method: "markPendingReconciliation", requestId, reason });
        settled();
        return reservationFor(requestId, "pending_reconciliation");
      },
      ...overrides,
    };
    return { billing, calls, done };
  };

  const principal: AuthenticatedPrincipal = {
    userId: "user-1",
    apiKeyId: "key-1",
    billingAccountId: "account-1",
  };

  const completeCompletion = (responseBody = "ok"): ProviderCompletion => ({
    state: "complete",
    providerRequestId: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: Usd.parse("0.01") },
    responseBody,
    bodyCapture: "complete",
  });

  test("reserves with the generated request id and account; ip attribute comes from cf-connecting-ip", async () => {
    const { billing, calls, done } = fakeBilling();
    const request = new Request("http://gateway.test/x", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

    const { metered, requestId } = await runProviderRoute({ billing }, request, principal, {
      provider: "test",
      endpoint: "test/endpoint",
      model: "test-model",
      estimatedCostUsd: Usd.parse("0.01"),
      execute: async (): Promise<MeteredProviderResponse> => ({
        response: new Response("ok"),
        requestBody: "{}",
        completion: Promise.resolve(completeCompletion()),
      }),
    });
    expect(metered.response.status).toBe(200);
    expect(metered.response.headers.get("x-request-id")).toBe(requestId);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await done;

    const reserveCall = calls.find((call) => call.method === "reserve");
    expect(reserveCall).toMatchObject({
      method: "reserve",
      input: { requestId, accountId: "account-1" },
    });

    const finalizeCall = calls.find((call) => call.method === "finalize");
    expect(finalizeCall?.method).toBe("finalize");
    if (finalizeCall?.method === "finalize") {
      expect(finalizeCall.input.analytics?.attributes).toMatchObject({ ip: "203.0.113.9" });
    }
  });

  test("maps InsufficientFundsError from reserve to a 429 HttpError with the shared message", async () => {
    const { billing } = fakeBilling({
      async reserve() {
        throw new InsufficientFundsError();
      },
    });
    const request = new Request("http://gateway.test/x");

    let thrown: unknown;
    try {
      await runProviderRoute({ billing }, request, principal, {
        provider: "test",
        endpoint: "test/endpoint",
        model: "test-model",
        estimatedCostUsd: Usd.parse("0.01"),
        execute: async () => {
          throw new Error("execute must not run when the reservation fails");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(429);
    expect((thrown as HttpError).message).toBe(
      "Spending limit reached. Need a higher limit? hey@mahadk.com",
    );
    expect((thrown as HttpError).toResponse().headers.get("x-should-retry")).toBe("false");
  });

  test("a rejected settled promise invokes onSettlementError with the request id and does not reject the route", async () => {
    const settlementError = new Error("finalize exploded");
    const { billing } = fakeBilling({
      async finalize() {
        throw settlementError;
      },
    });
    const request = new Request("http://gateway.test/x");
    const onSettlementError = (error: unknown, requestId: string) => {
      captured = { error, requestId };
    };
    let captured: { error: unknown; requestId: string } | undefined;

    const { metered, requestId } = await runProviderRoute(
      { billing, onSettlementError },
      request,
      principal,
      {
        provider: "test",
        endpoint: "test/endpoint",
        model: "test-model",
        estimatedCostUsd: Usd.parse("0.01"),
        execute: async (): Promise<MeteredProviderResponse> => ({
          response: new Response("ok"),
          requestBody: "{}",
          completion: Promise.resolve(completeCompletion()),
        }),
      },
    );
    expect(metered.response.status).toBe(200);

    await metered.settled.catch(() => {});
    // `settled.catch` above races the route's own `.catch` callback; give the
    // microtask queue one more turn so `onSettlementError` has run.
    await Promise.resolve();
    await Promise.resolve();

    expect(captured?.requestId).toBe(requestId);
    expect(captured?.error).toBe(settlementError);
  });

  test("mutating the input object by reference is reflected in the finalize analytics (Jev's model upgrade)", async () => {
    const { billing, calls, done } = fakeBilling();
    const request = new Request("http://gateway.test/x");

    const input = {
      provider: "typesafe",
      endpoint: "jev/systemone",
      model: "jev-latest",
      estimatedCostUsd: Usd.parse("0.01"),
      execute: async (): Promise<MeteredProviderResponse> => ({
        response: new Response("ok"),
        requestBody: "{}",
        completion: Promise.resolve(completeCompletion()).then((completion) => {
          input.model = "changed";
          return completion;
        }),
      }),
    };

    await runProviderRoute({ billing }, request, principal, input);
    await done;

    expect(input.model).toBe("changed");
    const finalizeCall = calls.find((call) => call.method === "finalize");
    expect(finalizeCall?.method).toBe("finalize");
    if (finalizeCall?.method === "finalize") {
      expect(finalizeCall.input.analytics?.model).toBe("changed");
    }
  });

  test("rewrapResponse: false returns execute's response untouched, with no x-request-id", async () => {
    const { billing } = fakeBilling();
    const request = new Request("http://gateway.test/x");
    const executeResponse = new Response("ok");

    const { metered } = await runProviderRoute(
      { billing },
      request,
      principal,
      {
        provider: "test",
        endpoint: "test/endpoint",
        model: "test-model",
        estimatedCostUsd: Usd.parse("0.01"),
        execute: async (): Promise<MeteredProviderResponse> => ({
          response: executeResponse,
          requestBody: "{}",
          completion: Promise.resolve(completeCompletion()),
        }),
      },
      { rewrapResponse: false },
    );

    expect(metered.response).toBe(executeResponse);
    expect(metered.response.headers.get("x-request-id")).toBeNull();
  });
});
