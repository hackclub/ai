import { describe, expect, test } from "bun:test";

import type {
  FinalizeInput,
  Reservation,
  ReserveInput,
} from "../billing/engine";
import { Usd } from "../billing/money";
import type {
  MeteredProviderResponse,
  ProviderCompletion,
} from "../providers/types";
import {
  type BillingLifecycle,
  redactHeaders,
  runMeteredRequest,
  SettlementTracker,
} from "./metered-request";

type Call =
  | { method: "reserve"; input: ReserveInput }
  | { method: "finalize"; input: FinalizeInput }
  | { method: "release"; requestId: string }
  | {
      method: "markPendingReconciliation";
      requestId: string;
      reason: string;
      providerRequestId: string | undefined;
    };

const reservationFor = (
  requestId: string,
  state: Reservation["state"],
): Reservation => ({
  id: "reservation-1",
  requestId,
  accountId: "account-1",
  provider: "openrouter",
  providerRequestId: null,
  state,
  estimatedCostUsd: "0.010000000000",
  actualCostUsd: null,
  unfundedCostUsd: "0.000000000000",
  expiresAt: new Date(0),
});

const fakeBilling = () => {
  const calls: Call[] = [];
  const billing: BillingLifecycle = {
    async reserve(input) {
      calls.push({ method: "reserve", input });
      return reservationFor(input.requestId, "reserved");
    },
    async finalize(input) {
      calls.push({ method: "finalize", input });
      return reservationFor(input.requestId, "finalized");
    },
    async release(requestId) {
      calls.push({ method: "release", requestId });
      return reservationFor(requestId, "released");
    },
    async markPendingReconciliation(requestId, reason, providerRequestId) {
      calls.push({
        method: "markPendingReconciliation",
        requestId,
        reason,
        providerRequestId,
      });
      return reservationFor(requestId, "pending_reconciliation");
    },
  };
  return { billing, calls };
};

const providerResponse = (
  completion: ProviderCompletion,
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

const baseInput = (execute: () => Promise<MeteredProviderResponse>) => ({
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

describe("runMeteredRequest", () => {
  test("reserves before dispatch and finalizes with provider usage", async () => {
    const { billing, calls } = fakeBilling();
    let executed = false;
    const completion: ProviderCompletion = {
      state: "complete",
      providerRequestId: "gen-1",
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        costUsd: Usd.parse("0.0004"),
      },
      responseBody: '{"id":"gen-1"}',
      bodyCapture: "complete",
    };

    const request = await runMeteredRequest(
      billing,
      baseInput(async () => {
        expect(calls[0]?.method).toBe("reserve");
        executed = true;
        return providerResponse(completion);
      }),
    );

    expect(executed).toBeTrue();
    expect(request.reservation.state).toBe("reserved");
    const outcome = await request.settled;
    expect(outcome.kind).toBe("finalized");

    const finalize = calls.find((call) => call.method === "finalize");
    if (finalize?.method !== "finalize") throw new Error("Expected finalize");
    expect(finalize.input.requestId).toBe("request-1");
    expect(finalize.input.actualCostUsd.toString()).toBe("0.000400000000");
    expect(finalize.input.usageSource).toBe("provider_reported");
    expect(finalize.input.providerRequestId).toBe("gen-1");

    const analytics = finalize.input.analytics ?? {};
    expect(analytics.outcome).toBe("completed");
    expect(analytics.http_status).toBe(200);
    expect(analytics.streamed).toBeFalse();
    expect(analytics.input_tokens).toBe(3);
    expect(analytics.output_tokens).toBe(2);
    expect(analytics.provider_cost_usd).toBe("0.000400000000");
    expect(analytics.request_body).toBe('{"model":"test/model"}');
    expect(analytics.response_body).toBe('{"id":"gen-1"}');
    expect(analytics.request_headers).toEqual({ "user-agent": "test" });
    expect(analytics.response_headers).toEqual({
      "content-type": "application/json",
    });
    expect(analytics.attributes).toEqual({
      client: "cli",
      body_capture: "complete",
    });
    expect(analytics.user_id).toBe("user-1");
    expect(analytics.api_key_id).toBe("key-1");
  });

  test("passes reservationTtlMs through to the billing engine as ttlMs", async () => {
    const { billing, calls } = fakeBilling();

    await runMeteredRequest(billing, {
      ...baseInput(async () => providerResponse({
        state: "complete",
        providerRequestId: "gen-2",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          costUsd: Usd.parse("0.0001"),
        },
        responseBody: '{"id":"gen-2"}',
        bodyCapture: "complete",
      })),
      reservationTtlMs: 1234,
    });

    const reserve = calls.find((call) => call.method === "reserve");
    if (reserve?.method !== "reserve") throw new Error("Expected reserve");
    expect(reserve.input.ttlMs).toBe(1234);
  });

  test("releases the reservation when dispatch fails", async () => {
    const { billing, calls } = fakeBilling();
    const failure = new Error("connect ECONNREFUSED");

    await expect(
      runMeteredRequest(
        billing,
        baseInput(async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    expect(calls.map((call) => call.method)).toEqual(["reserve", "release"]);
  });

  test("rethrows the dispatch error when release also fails", async () => {
    const { billing } = fakeBilling();
    const failure = new Error("connect ECONNREFUSED");
    const releaseFailure = new Error("pool closed");
    billing.release = async () => {
      throw releaseFailure;
    };
    const releaseErrors: Array<{ error: unknown; requestId: string }> = [];

    const input = {
      ...baseInput(async () => {
        throw failure;
      }),
      onReleaseError: (error: unknown, requestId: string) => {
        releaseErrors.push({ error, requestId });
      },
    };

    await expect(runMeteredRequest(billing, input)).rejects.toBe(failure);

    expect(releaseErrors).toEqual([
      { error: releaseFailure, requestId: "request-1" },
    ]);
  });

  test("drains tracked settlements", async () => {
    const { billing } = fakeBilling();
    const tracker = new SettlementTracker();
    billing.settlements = tracker;

    let resolveCompletion: (completion: ProviderCompletion) => void;
    const completionPromise = new Promise<ProviderCompletion>((resolve) => {
      resolveCompletion = resolve;
    });

    const request = await runMeteredRequest(
      billing,
      baseInput(async () => ({
        response: new Response("ignored", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        requestBody: '{"model":"test/model"}',
        completion: completionPromise,
      })),
    );

    expect(tracker.size).toBe(1);

    const drainPromise = tracker.drain(1_000);
    resolveCompletion!({
      state: "complete",
      providerRequestId: "gen-1",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: Usd.parse("0.0001"),
      },
      responseBody: "{}",
      bodyCapture: "complete",
    });

    const result = await drainPromise;
    expect(result).toEqual({ remaining: 0 });
    await request.settled;
  });

  test("drain times out and reports the remainder", async () => {
    const { billing } = fakeBilling();
    const tracker = new SettlementTracker();
    billing.settlements = tracker;

    const completionPromise = new Promise<ProviderCompletion>(() => {
      // Never resolves.
    });

    await runMeteredRequest(
      billing,
      baseInput(async () => ({
        response: new Response("ignored", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        requestBody: '{"model":"test/model"}',
        completion: completionPromise,
      })),
    );

    expect(tracker.size).toBe(1);
    const result = await tracker.drain(20);
    expect(result).toEqual({ remaining: 1 });
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
          return providerResponse({
            state: "uncertain",
            providerRequestId: null,
            reason: "unused",
            responseBody: "",
            bodyCapture: "complete",
          });
        }),
      ),
    ).rejects.toBe(refused);
    expect(executed).toBeFalse();
  });

  test("finalizes provider HTTP errors at zero cost", async () => {
    const { billing, calls } = fakeBilling();
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

    const outcome = await request.settled;
    expect(outcome.kind).toBe("finalized");
    const finalize = calls.find((call) => call.method === "finalize");
    if (finalize?.method !== "finalize") throw new Error("Expected finalize");
    expect(finalize.input.actualCostUsd.toAtoms()).toBe(0n);
    expect(finalize.input.usageSource).toBe("calculated");
    expect(finalize.input.analytics?.outcome).toBe("provider_error");
    expect(finalize.input.analytics?.error_code).toBe("http_400");
    expect(finalize.input.analytics?.provider_cost_usd).toBeNull();
  });

  test.each([
    ["uncertain", "OpenRouter response ended without authoritative cost"],
    ["cancelled", "client disconnected"],
  ] as const)(
    "marks a %s successful response pending reconciliation",
    async (state, reason) => {
      const { billing, calls } = fakeBilling();
      const completion: ProviderCompletion =
        state === "cancelled"
          ? {
              state,
              providerRequestId: "gen-2",
              reason,
              responseBody: "partial",
              bodyCapture: "partial",
            }
          : {
              state,
              providerRequestId: "gen-2",
              reason,
              responseBody: "partial",
              bodyCapture: "complete",
            };

      const request = await runMeteredRequest(
        billing,
        baseInput(async () =>
          providerResponse(completion, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );

      const outcome = await request.settled;
      expect(outcome.kind).toBe("pending_reconciliation");
      expect(outcome.reservation.state).toBe("pending_reconciliation");
      const pending = calls.find(
        (call) => call.method === "markPendingReconciliation",
      );
      if (pending?.method !== "markPendingReconciliation") {
        throw new Error("Expected pending reconciliation");
      }
      expect(pending.requestId).toBe("request-1");
      expect(pending.reason).toBe(reason);
      expect(pending.providerRequestId).toBe("gen-2");
      expect(calls.some((call) => call.method === "finalize")).toBeFalse();
    },
  );

  test("holds a successful response for reconciliation when completion rejects", async () => {
    const { billing, calls } = fakeBilling();
    const request = await runMeteredRequest(
      billing,
      baseInput(async () => ({
        response: new Response("ok", { status: 200 }),
        requestBody: "{}",
        completion: Promise.reject(new Error("adapter bug")),
      })),
    );

    const outcome = await request.settled;
    expect(outcome.kind).toBe("pending_reconciliation");
    const pending = calls.find((call) => call.method === "markPendingReconciliation");
    if (pending?.method !== "markPendingReconciliation") {
      throw new Error("Expected pending reconciliation");
    }
    expect(pending.reason).toBe("completion_rejected");
    expect(calls.some((call) => call.method === "finalize")).toBeFalse();
  });
});

describe("redactHeaders", () => {
  test("removes credentials and lower-cases names", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer secret",
        "Proxy-Authorization": "Basic x",
        Cookie: "session=1",
        "X-API-Key": "k",
        "Content-Type": "application/json",
      }),
    ).toEqual({ "content-type": "application/json" });
  });

  test("drops unknown headers so a credential in a novel header never reaches analytics", () => {
    expect(
      redactHeaders({
        "api-key": "sk-hc-v1-abc",
        "x-goog-api-key": "sk-hc-v1-abc",
        "x-stainless-lang": "js",
        "user-agent": "t",
      }),
    ).toEqual({ "x-stainless-lang": "js", "user-agent": "t" });
  });
});
