import { describe, expect, test } from "bun:test";

import { Usd } from "../billing/money";
import { OpenRouterAdapter } from "../providers/openrouter/adapter";
import type { MeteredProviderResponse, ProviderCompletion } from "../providers/types";
import {
  type MeteredRequestInput,
  redactHeaders,
  runMeteredRequest,
} from "./metered-request";
import { testDatabase } from "../test/database";
import {
  billingRecords,
  createTestAccount,
  onlyBillingRecord,
  testBilling,
  withFaults,
} from "./routes/test-harness";

const { sql } = await testDatabase();

// Provider request ids are unique per provider in the database, as upstream.
const complete = (costUsd = "0.0004", providerRequestId = "gen-1"): ProviderCompletion => ({
  state: "complete",
  providerRequestId,
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

/** A fresh account per test, so each test reads back only its own reservation. */
const setup = async () => {
  const account = await createTestAccount(sql, crypto.randomUUID());
  return { ...testBilling(sql), account, record: () => onlyBillingRecord(sql, account.accountId) };
};

const baseInput = (accountId: string, execute: MeteredRequestInput["execute"]): MeteredRequestInput => ({
  requestId: crypto.randomUUID(),
  accountId,
  userId: null,
  apiKeyId: null,
  provider: "openrouter",
  endpoint: "chat/completions",
  model: "test/model",
  estimatedCostUsd: Usd.parse("0.01"),
  analytics: {
    requestHeaders: { Authorization: "Bearer secret", "User-Agent": "test" },
    attributes: { client: "cli" },
  },
  execute,
});

const dispatchFailure = (accountId: string) => {
  const failure = new Error("connect ECONNREFUSED");
  return {
    failure,
    input: baseInput(accountId, async () => {
      throw failure;
    }),
  };
};

describe("runMeteredRequest", () => {
  test("reserves before dispatch and finalizes once with provider usage", async () => {
    const { billing, account, record } = await setup();
    let stateAtDispatch: string | undefined;

    const request = await runMeteredRequest(
      billing,
      baseInput(account.accountId, async () => {
        stateAtDispatch = (await record()).state;
        return providerResponse(complete());
      }),
    );

    expect(stateAtDispatch).toBe("reserved");
    expect(request.reservation.state).toBe("reserved");
    expect((await request.settled).kind).toBe("finalized");

    const finalized = await record();
    expect(finalized).toMatchObject({
      state: "finalized",
      usageSource: "provider_reported",
      providerRequestId: "gen-1",
      actualCostUsd: "0.000400000000",
    });
    // The event as the analytics worker will read it, after the engine's merge.
    expect(finalized.event).toMatchObject({
      account_id: account.accountId,
      provider: "openrouter",
      provider_request_id: "gen-1",
      billed_cost_usd: "0.000400000000",
      usage_source: "provider_reported",
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
    });
  });

  test("does not dispatch when the reservation is refused", async () => {
    const { billing, account } = await setup();
    let executed = false;
    const input = {
      ...baseInput(account.accountId, async () => {
        executed = true;
        return providerResponse(complete());
      }),
      // More than the $1 daily allowance.
      estimatedCostUsd: Usd.parse("5"),
    };

    await expect(runMeteredRequest(billing, input)).rejects.toThrow();
    expect(executed).toBeFalse();
    expect(await billingRecords(sql, account.accountId)).toEqual([]);
  });

  test("releases the reservation when dispatch fails", async () => {
    const { billing, account, record } = await setup();
    const { failure, input } = dispatchFailure(account.accountId);
    await expect(runMeteredRequest(billing, input)).rejects.toBe(failure);
    expect((await record()).state).toBe("released");
  });

  test("rethrows the dispatch error when release also fails", async () => {
    const { billing, account } = await setup();
    const releaseFailure = new Error("pool closed");
    const failing = withFaults(billing, {
      release: async () => {
        throw releaseFailure;
      },
    });
    const releaseErrors: unknown[][] = [];
    const { failure, input } = dispatchFailure(account.accountId);

    await expect(
      runMeteredRequest(failing, {
        ...input,
        onReleaseError: (...args) => releaseErrors.push(args),
      }),
    ).rejects.toBe(failure);
    expect(releaseErrors).toEqual([[releaseFailure, input.requestId]]);
  });

  test("finalizes provider HTTP errors at zero cost", async () => {
    const { billing, account, record } = await setup();
    const request = await runMeteredRequest(
      billing,
      baseInput(account.accountId, async () =>
        providerResponse(
          {
            state: "provider_error",
            providerRequestId: null,
            responseBody: '{"error":{"message":"Invalid model"}}',
            bodyCapture: "complete",
          },
          { status: 400 },
        ),
      ),
    );

    expect((await request.settled).kind).toBe("finalized");
    const finalized = await record();
    expect(finalized).toMatchObject({ state: "finalized", actualCostUsd: "0.000000000000", usageSource: "calculated" });
    expect(finalized.event).toMatchObject({
      outcome: "provider_error",
      error_code: "http_400",
      provider_cost_usd: null,
      billed_cost_usd: "0.000000000000",
    });
  });

  test("marks an uncertain successful response pending reconciliation", async () => {
    const { billing, account, record } = await setup();
    const reason = "OpenRouter response ended without authoritative cost";
    const request = await runMeteredRequest(
      billing,
      baseInput(account.accountId, async () =>
        providerResponse(
          { state: "uncertain", providerRequestId: "gen-uncertain", reason, responseBody: "partial", bodyCapture: "partial" },
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const outcome = await request.settled;
    expect(outcome.kind).toBe("pending_reconciliation");
    expect(outcome.reservation.state).toBe("pending_reconciliation");
    expect(await record()).toMatchObject({
      state: "pending_reconciliation",
      reconciliationReason: reason,
      providerRequestId: "gen-uncertain",
      event: null,
    });
  });

  test("holds an OpenRouter 504 without usage for reconciliation, not finalized at zero", async () => {
    const { billing, account, record } = await setup();
    // The 504 may come back while the generation still runs and bills.
    const adapter = new OpenRouterAdapter({
      fetch: async () =>
        new Response('{"error":{"message":"Gateway timeout"}}', {
          status: 504,
          headers: { "content-type": "application/json", "x-generation-id": "gen-504" },
        }),
    });
    const request = await runMeteredRequest(
      billing,
      baseInput(account.accountId, () =>
        adapter.execute({ endpoint: "chat/completions", body: { model: "test/model" }, apiKey: "secret" }),
      ),
    );
    expect(request.response.status).toBe(504);
    await request.response.text();

    expect((await request.settled).kind).toBe("pending_reconciliation");
    expect(await record()).toMatchObject({
      state: "pending_reconciliation",
      providerRequestId: "gen-504",
      reconciliationReason: "OpenRouter gateway timeout; generation may still be running",
      event: null,
    });
  });

  test("holds a successful response for reconciliation when completion rejects", async () => {
    const { billing, account, record } = await setup();
    const request = await runMeteredRequest(
      billing,
      baseInput(account.accountId, async () => ({
        response: new Response("ok", { status: 200 }),
        requestBody: "{}",
        completion: Promise.reject(new Error("adapter bug")),
      })),
    );

    expect((await request.settled).kind).toBe("pending_reconciliation");
    expect(await record()).toMatchObject({
      state: "pending_reconciliation",
      reconciliationReason: "completion_rejected",
    });
  });

  test("holds an error response for reconciliation when completion rejects", async () => {
    // The completion is the only billing authority: without one, a 5xx is
    // not assumed to be free.
    const { billing, account, record } = await setup();
    const request = await runMeteredRequest(
      billing,
      baseInput(account.accountId, async () => ({
        response: new Response("upstream down", { status: 500 }),
        requestBody: "{}",
        completion: Promise.reject(new Error("adapter bug")),
      })),
    );

    expect((await request.settled).kind).toBe("pending_reconciliation");
    expect(await record()).toMatchObject({
      state: "pending_reconciliation",
      reconciliationReason: "completion_rejected",
    });
  });
});

describe("SettlementTracker", () => {
  const trackedRequest = async (completion: Promise<ProviderCompletion>) => {
    const { billing, settlements: tracker, account } = await setup();
    const request = await runMeteredRequest(
      billing,
      baseInput(account.accountId, async () => providerResponse(completion)),
      tracker,
    );
    expect(tracker.size).toBe(1);
    return { tracker, request };
  };

  test("drains tracked settlements", async () => {
    let resolve!: (completion: ProviderCompletion) => void;
    const { tracker, request } = await trackedRequest(new Promise((r) => (resolve = r)));
    const drained = tracker.drain(1_000);
    resolve(complete("0.0004", `gen-${crypto.randomUUID()}`));
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
