import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { allowedReplicateModels } from "../../config/replicate-models";
import { blockedPrompts } from "../../config/blocked-prompts";
import type { Fetch } from "../../providers/openrouter/adapter";
import type { ReplicatePricing } from "../../providers/replicate/pricing";
import type { ProviderCompletion } from "../../providers/types";
import { BLOCKED_MESSAGE } from "../abuse";
import {
  meterPrediction,
  type PredictionSettlement,
  replicateRoutes,
  resolveModelReference,
  rewriteUpstreamLinks,
  validateModelAccess,
  validateVersionAccess,
  versionFromModelName,
  type ReplicateRouteDependencies,
} from "./replicate";
import { fakeBilling, fakeSql, post } from "./test-harness";

const knownVersion = Object.keys(allowedReplicateModelVersions)[0] ?? "";
const knownModel = allowedReplicateModelVersions[knownVersion] ?? "";

const pricing: ReplicatePricing = {
  kind: "hardware",
  hardware: "T4",
  perSecondUsd: Usd.parse("0.001"),
  medianRunUsd: Usd.parse("0.002"),
};

function expectState<S extends ProviderCompletion["state"]>(
  completion: ProviderCompletion,
  state: S,
): asserts completion is Extract<ProviderCompletion, { state: S }> {
  expect(completion.state).toBe(state);
  if (completion.state !== state) throw new Error(`expected ${state}`);
}

describe("Replicate allowlist", () => {
  test("accepts listed models and strips version suffixes", () => {
    const [owner, name] = knownModel.split("/");
    expect(validateModelAccess(owner ?? "", `${name}:${knownVersion}`)).toBe(knownModel);
    expect(versionFromModelName(`${name}:${knownVersion}`)).toBe(knownVersion);
    expect(versionFromModelName(name ?? "")).toBeUndefined();
  });

  test("rejects unlisted models and mismatched versions", () => {
    expect(() => validateModelAccess("evil", "model")).toThrow(
      "Model evil/model is not in the allowed list.",
    );
    expect(() => validateVersionAccess("other/model", knownVersion)).toThrow(
      `Model other/model:${knownVersion} is not in the allowed list.`,
    );
    expect(() => validateVersionAccess(knownModel, knownVersion)).not.toThrow();
  });

  test("resolves every version form Replicate accepts against the allowlist", () => {
    const canonical = `${knownModel}:${knownVersion}`;
    expect(resolveModelReference(knownVersion)).toEqual({ model: knownModel, version: canonical });
    expect(resolveModelReference(canonical)).toEqual({ model: knownModel, version: canonical });
    expect(resolveModelReference(knownModel)).toEqual({ model: knownModel, version: null });
    // An unknown version id, or a known model paired with someone else's version, is refused.
    expect(() => resolveModelReference("a".repeat(64))).toThrow("is not in the allowed list");
    expect(() => resolveModelReference(`${knownModel}:${"a".repeat(64)}`)).toThrow(
      "is not in the allowed list",
    );
    expect(() => resolveModelReference("black-forest-labs/flux-1.1-pro")).toThrow(
      "is not in the allowed list",
    );
    expect(() => resolveModelReference("nonsense")).toThrow("Invalid model format.");
  });

  test("every allowlisted version belongs to an allowlisted model", () => {
    for (const model of Object.values(allowedReplicateModelVersions)) {
      expect(allowedReplicateModels).toContain(model);
    }
  });
});

describe("rewriteUpstreamLinks", () => {
  const from = "https://api.replicate.com/v1/";
  const to = "https://gateway.test/proxy/v1/replicate/";

  test("points API links at the gateway but leaves model data and stream links alone", () => {
    const prediction = {
      id: "p1",
      urls: {
        get: `${from}predictions/p1`,
        cancel: `${from}predictions/p1/cancel`,
        stream: "https://stream.replicate.com/v1/files/abc",
        web: "https://replicate.com/p/p1",
      },
      input: { get: `${from}predictions/other` },
      output: [`${from}predictions/other`],
    };
    expect(rewriteUpstreamLinks(prediction, from, to)).toEqual({
      ...prediction,
      urls: {
        ...prediction.urls,
        get: `${to}predictions/p1`,
        cancel: `${to}predictions/p1/cancel`,
      },
    });
    expect(rewriteUpstreamLinks({ next: `${from}models/a/b/versions?cursor=x`, previous: null, results: [] }, from, to))
      .toEqual({ next: `${to}models/a/b/versions?cursor=x`, previous: null, results: [] });
  });
});

describe("meterPrediction", () => {
  const noSleep = async () => {};
  const meter = (upstream: Response, settlement: Partial<PredictionSettlement> = {}) =>
    meterPrediction(upstream, "{}", {
      pricing,
      lookup: async () => null,
      timeoutMs: 10_000,
      sleep: noSleep,
      ...settlement,
    });
  /** Reads the body to the end, as a client would, then waits for settlement. */
  const settle = async (upstream: Response, settlement?: Partial<PredictionSettlement>) => {
    const metered = meter(upstream, settlement);
    await metered.response.text();
    return metered.completion;
  };

  test("bills a terminal response from its metrics without polling", async () => {
    const lookups: string[] = [];
    const completion = await settle(
      Response.json({ id: "p1", status: "succeeded", metrics: { predict_time: 1.5 } }),
      {
        lookup: async (id) => {
          lookups.push(id);
          return null;
        },
      },
    );
    expectState(completion, "complete");
    expect(completion.usage.costUsd.toString()).toBe(Usd.parse("0.0015").toString());
    expect(completion.providerRequestId).toBe("p1");
    expect(lookups).toEqual([]);
  });

  test("polls an async prediction until it finishes, then bills it", async () => {
    let polls = 0;
    const completion = await settle(Response.json({ id: "p2", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        polls += 1;
        return polls < 3
          ? { id: "p2", status: "processing" }
          : { id: "p2", status: "failed", metrics: { predict_time: 4 } };
      },
    });
    expectState(completion, "complete");
    // A failed run still bills the hardware time Replicate reports.
    expect(completion.usage.costUsd.toString()).toBe(Usd.parse("0.004").toString());
    expect(polls).toBe(3);
  });

  test("treats an aborted prediction as terminal", async () => {
    let polls = 0;
    const completion = await settle(Response.json({ id: "p5", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        polls += 1;
        return { id: "p5", status: "aborted" };
      },
    });
    expectState(completion, "complete");
    expect(completion.usage.costUsd.toString()).toBe(Usd.zero.toString());
    expect(polls).toBe(1);
  });

  test("leaves the reservation uncertain when the prediction never finishes", async () => {
    const completion = await settle(Response.json({ id: "p3", status: "starting" }, { status: 201 }), {
      lookup: async () => ({ id: "p3", status: "processing" }),
      timeoutMs: 1,
      sleep: () => Bun.sleep(2),
    });
    expectState(completion, "uncertain");
    expect(completion.reason).toContain("p3");
    // The id is what reconciliation needs to bill the prediction later.
    expect(completion.providerRequestId).toBe("p3");
  });

  test("holds a succeeded prediction without billable metrics for reconciliation", async () => {
    const completion = await settle(
      Response.json({ id: "p6", status: "succeeded", metrics: { total_time: 3 } }),
    );
    expectState(completion, "uncertain");
    expect(completion.providerRequestId).toBe("p6");
    expect(completion.reason).toContain("without billable metrics");
  });

  test("marks a provider error uncertain", async () => {
    const completion = await settle(Response.json({ detail: "bad" }, { status: 422 }));
    expect(completion.state).toBe("uncertain");
  });

  test("retries a transient lookup failure instead of abandoning settlement", async () => {
    let calls = 0;
    const completion = await settle(Response.json({ id: "p10", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        calls += 1;
        if (calls === 1) throw new Error("502 from Replicate");
        return { id: "p10", status: "succeeded", metrics: { predict_time: 1 } };
      },
    });
    expect(completion.state).toBe("complete");
    expect(calls).toBe(2);
  });

  test("gives up after a run of consecutive lookup failures", async () => {
    let calls = 0;
    const completion = await settle(Response.json({ id: "p11", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        calls += 1;
        throw new Error("still down");
      },
    });
    expectState(completion, "uncertain");
    expect(completion.reason).toBe("still down");
    expect(completion.providerRequestId).toBe("p11");
    expect(calls).toBe(5);
  });

  test("settles a cancellation even when the upstream cancel rejects", async () => {
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Buffer.from('{"id":"p7","status":"starting"}'));
        },
        cancel() {
          throw new Error("socket already closed");
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
    const metered = meter(upstream);
    const reader = metered.response.body?.getReader();
    await reader?.read();
    await reader?.cancel("client disconnected");
    const completion = await metered.completion;
    expectState(completion, "cancelled");
    expect(completion.providerRequestId).toBe("p7");
    expect(completion.reason).toBe("client disconnected");
  });
});

/** Answers the daily upload count and, optionally, fails the ownership insert. */
const replicateSql = ({ uploadsToday = 0, failOwnershipInsert = false } = {}) =>
  fakeSql((query) => {
    if (query.includes("count(*)")) return [{ n: String(uploadsToday) }];
    if (failOwnershipInsert && query.includes("replicate_resources") && query.includes("INSERT")) {
      throw new Error("insert failed");
    }
    return undefined;
  });

const buildApp = (deps: Partial<ReplicateRouteDependencies> & { fetch: Fetch }) =>
  replicateRoutes({
    sql: replicateSql(),
    billing: fakeBilling().billing,
    replicateApiKey: "test-key",
    enforceIdv: false,
    pricing: { get: async () => pricing },
    ...deps,
  });

type App = ReturnType<typeof replicateRoutes>;

const postPrediction = (app: App, body: unknown) => app.handle(post("/proxy/v1/replicate/predictions", body));

const uploadFile = (app: App, content: BlobPart = new Uint8Array(8)) => {
  const form = new FormData();
  form.append("content", new Blob([content]), "upload.bin");
  return app.handle(
    new Request("http://gateway.test/proxy/v1/replicate/files", {
      method: "POST",
      headers: { authorization: "Bearer sk-hc-v1-test" },
      body: form,
    }),
  );
};

const refuseFetch = (calls: string[] = []): Fetch => async (input) => {
  calls.push(String(input));
  throw new Error("upstream must not be called");
};

describe("POST /predictions", () => {
  test("returns the prediction even when recording ownership fails, and reports it", async () => {
    const errors: unknown[] = [];
    const app = buildApp({
      sql: replicateSql({ failOwnershipInsert: true }),
      fetch: async (input) => {
        const url = String(input);
        if (!url.includes(`/v1/models/${knownModel}/predictions`)) throw new Error(`Unexpected fetch: ${url}`);
        return Response.json({ id: "p9", status: "succeeded", metrics: { predict_time: 1 }, urls: {} }, { status: 201 });
      },
      onSettlementError: (error) => errors.push(error),
    });

    const response = await postPrediction(app, { version: knownModel, input: {} });

    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toBe("p9");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("p9");
  });

  // `billing: {} as never` proves neither refusal reaches billing.
  test("refuses a blocked prompt before billing or upstream", async () => {
    const fetchCalls: string[] = [];
    const app = buildApp({ billing: {} as never, fetch: refuseFetch(fetchCalls) });
    const response = await postPrediction(app, { version: knownModel, input: { prompt: blockedPrompts[0] } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
    expect(fetchCalls).toEqual([]);
  });

  test("rejects webhook fields before billing or upstream", async () => {
    const fetchCalls: string[] = [];
    const app = buildApp({ billing: {} as never, fetch: refuseFetch(fetchCalls) });
    const response = await postPrediction(app, {
      version: knownModel,
      input: {},
      webhook: "https://attacker.example/hook?secret=1",
    });
    expect(response.status).toBe(400);
    expect(fetchCalls).toEqual([]);
  });
});

describe("POST /files", () => {
  const created = (id: string): Fetch => async () => Response.json({ id }, { status: 201 });

  test("enforces the upload size limit before contacting Replicate", async () => {
    const fetchCalls: string[] = [];
    const over = await uploadFile(buildApp({ maxUploadBytes: 16, fetch: refuseFetch(fetchCalls) }), new Uint8Array(17));
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toContain("upload limit");
    expect(fetchCalls).toEqual([]);

    const atLimit = await uploadFile(buildApp({ maxUploadBytes: 16, fetch: created("f1") }), new Uint8Array(16));
    expect(atLimit.status).toBe(201);
  });

  test("caps uploads per user", async () => {
    const fetchCalls: string[] = [];
    const app = buildApp({ sql: replicateSql({ uploadsToday: 200 }), fetch: refuseFetch(fetchCalls) });
    expect((await uploadFile(app)).status).toBe(429);
    expect(fetchCalls).toEqual([]);
  });

  test("keeps the file id when the ownership insert fails", async () => {
    const errors: unknown[] = [];
    const app = buildApp({
      sql: replicateSql({ failOwnershipInsert: true }),
      fetch: created("f2"),
      onSettlementError: (error) => errors.push(error),
    });
    const response = await uploadFile(app);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toBe("f2");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("f2");
  });

  test("records an upload as a zero-cost metered request without its bytes", async () => {
    const { billing, reserves, finalizes, settled } = fakeBilling();
    const response = await uploadFile(buildApp({ billing, fetch: created("f3") }), Buffer.from("secret file bytes"));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    await response.text();
    await settled();
    expect(reserves().map((input) => input.estimatedCostUsd.toAtoms())).toEqual([0n]);
    expect(finalizes().map((input) => input.actualCostUsd.toAtoms())).toEqual([0n]);
    expect(String(finalizes()[0]?.analytics?.request_body)).not.toContain("secret file bytes");
  });

  test("records an upstream failure at zero cost", async () => {
    const { billing, finalizes, settled } = fakeBilling();
    const app = buildApp({ billing, fetch: async () => new Response("upstream failure", { status: 500 }) });
    const response = await uploadFile(app);
    expect(response.status).toBe(500);
    await response.text();
    await settled();
    expect(finalizes()).toHaveLength(1);
    expect(finalizes()[0]?.actualCostUsd.toAtoms()).toBe(0n);
    expect(finalizes()[0]?.analytics?.outcome).toBe("provider_error");
  });
});
