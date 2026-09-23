import { describe, expect, test } from "bun:test";

import { Usd } from "../billing/money";
import type { MeteredProviderResponse, ProviderCompletion } from "../providers/types";
import {
  type MeteredRequestInput,
  redactHeaders,
  runMeteredRequest,
} from "./metered-request";
import { fakeBilling } from "./routes/test-harness";

const complete = (costUsd = "0.0004"): ProviderCompletion => ({
  state: "complete",
  providerRequestId: "gen-1",
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: Usd.parse(costUsd) },
  responseBody: '{"id":"gen-1"}',
  bodyCapture: "complete",
});

const providerResponse = (
  completion: ProviderCompletion | Promise<ProviderCompletion>,
  init: ResponseInit = {},
): MeteredProviderResponse => ({
  response: new Response("ignored", {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": "x=1" },
    ...init,
  }),
  requestBody: '{"model":"test/model"}',
  completion: Promise.resolve(completion),
});

const baseInput = (execute: MeteredRequestInput["execute"]): MeteredRequestInput => ({
  requestId: "request-1",
  accountId: "account-1",
  provider: "openrouter",
  endpoint: "chat/completions",
  model: "test/model",
  estimatedCostUsd: Usd.parse("0.01"),
  analytics: {
    userId: "user-1",
    apiKeyId: "key-1",
    requestHeaders: { Authorization: "Bearer secret", "User-Agent": "test" },
    attributes: { client: "cli" },
  },
  execute,
});

const dispatchFailure = () => {
  const failure = new Error("connect ECONNREFUSED");
  return {
    failure,
    input: baseInput(async () => {
      throw failure;
    }),
  };
};

describe("runMeteredRequest", () => {
  test("reserves before dispatch and finalizes once with provider usage", async () => {
    const { billing, methods, only } = fakeBilling();
    let reservedBeforeDispatch = false;

    const request = await runMeteredRequest(
      billing,
      baseInput(async () => {
        reservedBeforeDispatch = methods().join() === "reserve";
        return providerResponse(complete());
      }),
    );

    expect(reservedBeforeDispatch).toBeTrue();
    expect(request.reservation.state).toBe("reserved");
    expect((await request.settled).kind).toBe("finalized");
    expect(methods()).toEqual(["reserve", "finalize"]);

    const { input } = only("finalize");
    expect(input).toMatchObject({
      requestId: "request-1",
      usageSource: "provider_reported",
      providerRequestId: "gen-1",
    });
    expect(input.actualCostUsd.toString()).toBe("0.000400000000");
    expect(input.analytics).toMatchObject({
      outcome: "completed",
      http_status: 200,
      streamed: false,
      input_tokens: 3,
      output_tokens: 2,
      provider_cost_usd: "0.000400000000",
      request_body: '{"model":"test/model"}',
      response_body: '{"id":"gen-1"}',
      // Credentials and set-cookie are dropped on both sides.
      request_headers: { "user-agent": "test" },
      response_headers: { "content-type": "application/json" },
      attributes: { client: "cli", body_capture: "complete" },
      user_id: "user-1",
      api_key_id: "key-1",
    });
  });

  test("does not dispatch when the reservation is refused", async () => {
    const { billing } = fakeBilling();
    const refused = new Error("insufficient funds");
    billing.reserve = async () => {
      throw refused;
    };
    let executed = false;

    await expect(
      runMeteredRequest(
        billing,
        baseInput(async () => {
          executed = true;
          return providerResponse(complete());
        }),
      ),
    ).rejects.toBe(refused);
    expect(executed).toBeFalse();
  });

  test("releases the reservation when dispatch fails", async () => {
    const { billing, methods } = fakeBilling();
    const { failure, input } = dispatchFailure();
    await expect(runMeteredRequest(billing, input)).rejects.toBe(failure);
    expect(methods()).toEqual(["reserve", "release"]);
  });

  test("rethrows the dispatch error when release also fails", async () => {
    const { billing } = fakeBilling();
    const releaseFailure = new Error("pool closed");
    billing.release = async () => {
      throw releaseFailure;
    };
    const releaseErrors: unknown[][] = [];
    const { failure, input } = dispatchFailure();

    await expect(
      runMeteredRequest(billing, {
        ...input,
        onReleaseError: (...args) => releaseErrors.push(args),
      }),
    ).rejects.toBe(failure);
    expect(releaseErrors).toEqual([[releaseFailure, "request-1"]]);
  });

  test("finalizes provider HTTP errors at zero cost", async () => {
    const { billing, only } = fakeBilling();
    const request = await runMeteredRequest(
      billing,
      baseInput(async () =>
        providerResponse(
          {
            state: "uncertain",
            providerRequestId: null,
            reason: "Invalid model",
            responseBody: '{"error":{"message":"Invalid model"}}',
            bodyCapture: "complete",
          },
          { status: 400 },
        ),
      ),
    );

    expect((await request.settled).kind).toBe("finalized");
    const { input } = only("finalize");
    expect(input.actualCostUsd.toAtoms()).toBe(0n);
    expect(input.usageSource).toBe("calculated");
    expect(input.analytics).toMatchObject({
      outcome: "provider_error",
      error_code: "http_400",
      provider_cost_usd: null,
    });
  });

  test.each([
    ["uncertain", "OpenRouter response ended without authoritative cost"],
    ["cancelled", "client disconnected"],
  ] as const)("marks a %s successful response pending reconciliation", async (state, reason) => {
    const { billing, methods, only } = fakeBilling();
    const request = await runMeteredRequest(
      billing,
      baseInput(async () =>
        providerResponse(
          { state, providerRequestId: "gen-2", reason, responseBody: "partial", bodyCapture: "partial" },
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const outcome = await request.settled;
    expect(outcome.kind).toBe("pending_reconciliation");
    expect(outcome.reservation.state).toBe("pending_reconciliation");
    expect(methods()).toEqual(["reserve", "markPendingReconciliation"]);
    expect(only("markPendingReconciliation")).toMatchObject({
      requestId: "request-1",
      reason,
      providerRequestId: "gen-2",
    });
  });

  test("holds a successful response for reconciliation when completion rejects", async () => {
    const { billing, methods, only } = fakeBilling();
    const request = await runMeteredRequest(
      billing,
      baseInput(async () => ({
        response: new Response("ok", { status: 200 }),
        requestBody: "{}",
        completion: Promise.reject(new Error("adapter bug")),
      })),
    );

    expect((await request.settled).kind).toBe("pending_reconciliation");
    expect(methods()).toEqual(["reserve", "markPendingReconciliation"]);
    expect(only("markPendingReconciliation").reason).toBe("completion_rejected");
  });
});

describe("SettlementTracker", () => {
  const trackedRequest = async (completion: Promise<ProviderCompletion>) => {
    const { billing, settlements: tracker } = fakeBilling();
    const request = await runMeteredRequest(billing, baseInput(async () => providerResponse(completion)));
    expect(tracker.size).toBe(1);
    return { tracker, request };
  };

  test("drains tracked settlements", async () => {
    let resolve!: (completion: ProviderCompletion) => void;
    const { tracker, request } = await trackedRequest(new Promise((r) => (resolve = r)));
    const drained = tracker.drain(1_000);
    resolve(complete());
    expect(await drained).toEqual({ remaining: 0 });
    await request.settled;
  });

  test("drain times out and reports the remainder", async () => {
    const { tracker } = await trackedRequest(new Promise(() => {}));
    expect(await tracker.drain(20)).toEqual({ remaining: 1 });
  });
});

test("redactHeaders keeps only allow-listed headers, lower-cased", () => {
  expect(
    redactHeaders({
      Authorization: "Bearer secret",
      "Proxy-Authorization": "Basic x",
      Cookie: "session=1",
      "X-API-Key": "k",
      // Unknown headers are dropped so a credential in a novel header never reaches analytics.
      "api-key": "sk-hc-v1-abc",
      "x-goog-api-key": "sk-hc-v1-abc",
      "Content-Type": "application/json",
      "x-stainless-lang": "js",
    }),
  ).toEqual({ "content-type": "application/json", "x-stainless-lang": "js" });
});
