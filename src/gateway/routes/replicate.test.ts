import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { allowedReplicateModels } from "../../config/replicate-models";
import type { ReplicatePricing } from "../../providers/replicate/pricing";
import {
  meterPrediction,
  replicateRoutes,
  resolveModelReference,
  rewriteUpstreamLinks,
  validateModelAccess,
  validateVersionAccess,
  versionFromModelName,
  type ReplicateRouteDependencies,
} from "./replicate";

const knownVersion = Object.keys(allowedReplicateModelVersions)[0] ?? "";
const knownModel = allowedReplicateModelVersions[knownVersion] ?? "";

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
  const pricing: ReplicatePricing = {
    kind: "hardware",
    hardware: "T4",
    perSecondUsd: Usd.parse("0.001"),
    medianRunUsd: Usd.parse("0.002"),
  };
  const drain = async (response: Response) => response.text();
  const noSleep = async () => {};

  test("bills a terminal response from its metrics without polling", async () => {
    const lookups: string[] = [];
    const upstream = Response.json({ id: "p1", status: "succeeded", metrics: { predict_time: 1.5 } });
    const metered = meterPrediction(upstream, "{}", {
      pricing,
      lookup: async (id) => {
        lookups.push(id);
        return null;
      },
      timeoutMs: 1_000,
      sleep: noSleep,
    });
    await drain(metered.response);
    const completion = await metered.completion;
    expect(completion.state).toBe("complete");
    if (completion.state !== "complete") return;
    expect(completion.usage.costUsd.toString()).toBe(Usd.parse("0.0015").toString());
    expect(completion.providerRequestId).toBe("p1");
    expect(lookups).toEqual([]);
  });

  test("polls an async prediction until it finishes, then bills it", async () => {
    let polls = 0;
    const upstream = Response.json({ id: "p2", status: "starting" }, { status: 201 });
    const metered = meterPrediction(upstream, "{}", {
      pricing,
      lookup: async () => {
        polls += 1;
        return polls < 3
          ? { id: "p2", status: "processing" }
          : { id: "p2", status: "failed", metrics: { predict_time: 4 } };
      },
      timeoutMs: 10_000,
      sleep: noSleep,
    });
    await drain(metered.response);
    const completion = await metered.completion;
    expect(completion.state).toBe("complete");
    if (completion.state !== "complete") return;
    // A failed run still bills the hardware time Replicate reports.
    expect(completion.usage.costUsd.toString()).toBe(Usd.parse("0.004").toString());
    expect(polls).toBe(3);
  });

  test("treats an aborted prediction as terminal", async () => {
    let polls = 0;
    const upstream = Response.json({ id: "p5", status: "starting" }, { status: 201 });
    const metered = meterPrediction(upstream, "{}", {
      pricing,
      lookup: async () => {
        polls += 1;
        return { id: "p5", status: "aborted" };
      },
      timeoutMs: 10_000,
      sleep: noSleep,
    });
    await drain(metered.response);
    const completion = await metered.completion;
    expect(completion.state).toBe("complete");
    if (completion.state !== "complete") return;
    expect(completion.usage.costUsd.toString()).toBe(Usd.zero.toString());
    expect(polls).toBe(1);
  });

  test("leaves the reservation uncertain when the prediction never finishes", async () => {
    const upstream = Response.json({ id: "p3", status: "starting" }, { status: 201 });
    const metered = meterPrediction(upstream, "{}", {
      pricing,
      lookup: async () => ({ id: "p3", status: "processing" }),
      timeoutMs: 1,
      sleep: () => Bun.sleep(2),
    });
    await drain(metered.response);
    const completion = await metered.completion;
    expect(completion.state).toBe("uncertain");
    if (completion.state !== "uncertain") return;
    expect(completion.reason).toContain("p3");
    // The id is what reconciliation needs to bill the prediction later.
    expect(completion.providerRequestId).toBe("p3");
  });

  test("holds a succeeded prediction without billable metrics for reconciliation", async () => {
    const upstream = Response.json({ id: "p6", status: "succeeded", metrics: { total_time: 3 } });
    const metered = meterPrediction(upstream, "{}", {
      pricing,
      lookup: async () => null,
      timeoutMs: 1_000,
      sleep: noSleep,
    });
    await drain(metered.response);
    const completion = await metered.completion;
    expect(completion.state).toBe("uncertain");
    if (completion.state !== "uncertain") return;
    expect(completion.providerRequestId).toBe("p6");
    expect(completion.reason).toContain("without billable metrics");
  });

  test("marks provider errors and lookup failures uncertain", async () => {
    const errored = meterPrediction(Response.json({ detail: "bad" }, { status: 422 }), "{}", {
      pricing,
      lookup: async () => null,
      timeoutMs: 1_000,
      sleep: noSleep,
    });
    await drain(errored.response);
    expect((await errored.completion).state).toBe("uncertain");

    const broken = meterPrediction(Response.json({ id: "p4", status: "starting" }), "{}", {
      pricing,
      lookup: async () => {
        throw new Error("lookup exploded");
      },
      timeoutMs: 1_000,
      sleep: noSleep,
    });
    await drain(broken.response);
    const completion = await broken.completion;
    expect(completion.state).toBe("uncertain");
    if (completion.state !== "uncertain") return;
    expect(completion.reason).toBe("lookup exploded");
    expect(completion.providerRequestId).toBe("p4");
  });

  test("settles a cancellation even when the upstream cancel rejects", async () => {
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"p7","status":"starting"}'));
        },
        cancel() {
          throw new Error("socket already closed");
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
    const metered = meterPrediction(upstream, "{}", { pricing, lookup: async () => null, timeoutMs: 1_000, sleep: noSleep });
    const reader = metered.response.body?.getReader();
    await reader?.read();
    await reader?.cancel("client disconnected");
    const completion = await metered.completion;
    expect(completion.state).toBe("cancelled");
    if (completion.state !== "cancelled") return;
    expect(completion.providerRequestId).toBe("p7");
    expect(completion.reason).toBe("client disconnected");
  });

  test("settles once: a cancellation that wins the race is not overwritten by a later pull failure", async () => {
    let pulls = 0;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode('{"id":"p8","status":"starting"}'));
            return;
          }
          throw new Error("stream broke after cancel");
        },
        cancel() {},
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
    const metered = meterPrediction(upstream, "{}", { pricing, lookup: async () => null, timeoutMs: 1_000, sleep: noSleep });
    const reader = metered.response.body?.getReader();
    await reader?.read();
    await reader?.cancel("client disconnected");
    const completion = await metered.completion;
    // The settleOnce guard means the first outcome (cancelled) wins, even if
    // Bun were to invoke `pull` again after `cancel` and throw.
    expect(completion.state).toBe("cancelled");
  });
});

describe("billedPrediction ownership failures", () => {
  const pricing: ReplicatePricing = {
    kind: "hardware",
    hardware: "T4",
    perSecondUsd: Usd.parse("0.001"),
    medianRunUsd: Usd.parse("0.002"),
  };

  test("returns the prediction even when recording ownership fails, and reports it", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const apiKeyId = "22222222-2222-2222-2222-222222222222";
    const billingAccountId = "33333333-3333-3333-3333-333333333333";

    const fakeSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM api_keys")) {
        return [
          {
            api_key_id: apiKeyId,
            user_id: userId,
            billing_account_id: billingAccountId,
            billing_account_status: "active",
            is_banned: false,
            is_idv_verified: true,
            skip_idv: true,
          },
        ];
      }
      if (query.includes("replicate_resources") && query.includes("INSERT")) {
        throw new Error("insert failed");
      }
      return [];
    }) as unknown as ReplicateRouteDependencies["sql"];

    const reservation = (requestId: string, state: "reserved" | "finalized") => ({
      id: `res-${requestId}`,
      requestId,
      accountId: billingAccountId,
      provider: "replicate",
      providerRequestId: null,
      state,
      estimatedCostUsd: "0.010000000000",
      actualCostUsd: null,
      unfundedCostUsd: "0.000000000000",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const billing = {
      reserve: async (input: { requestId: string }) => reservation(input.requestId, "reserved"),
      finalize: async (input: { requestId: string }) => reservation(input.requestId, "finalized"),
      release: async (requestId: string) => reservation(requestId, "finalized"),
      markPendingReconciliation: async (requestId: string) => reservation(requestId, "finalized"),
    } as unknown as ReplicateRouteDependencies["billing"];

    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/v1/models/${knownModel}/predictions`)) {
        return Response.json(
          { id: "p9", status: "succeeded", metrics: { predict_time: 1 }, urls: {} },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const errors: Array<{ error: unknown; requestId: string }> = [];

    const app = replicateRoutes({
      sql: fakeSql,
      billing,
      replicateApiKey: "test-key",
      enforceIdv: false,
      fetch: fakeFetch,
      pricing: { get: async () => pricing },
      onSettlementError: (error, requestId) => errors.push({ error, requestId }),
    });

    const response = await app.handle(
      new Request("http://localhost/proxy/v1/replicate/predictions", {
        method: "POST",
        headers: { authorization: "Bearer sk-hc-v1-test", "content-type": "application/json" },
        body: JSON.stringify({ version: knownModel, input: {} }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe("p9");
    expect(errors).toHaveLength(1);
    expect(String((errors[0]?.error as Error)?.message)).toContain("p9");
  });
});

describe("POST /files size limit", () => {
  const principalSql = (async () => [
    {
      user_id: "u1",
      api_key_id: "k1",
      billing_account_id: "a1",
      billing_account_status: "active",
      is_banned: false,
      is_idv_verified: true,
      skip_idv: false,
    },
  ]) as unknown as ReplicateRouteDependencies["sql"];

  const buildApp = (fetchImpl: typeof fetch) =>
    replicateRoutes({
      sql: principalSql,
      billing: {} as never, // never reached by this route
      replicateApiKey: "test",
      enforceIdv: false,
      maxUploadBytes: 16,
      fetch: fetchImpl,
    });

  test("rejects an upload over the limit with 413 before contacting Replicate", async () => {
    const app = buildApp((async () => {
      throw new Error("upstream must not be called");
    }) as unknown as typeof fetch);

    const form = new FormData();
    form.append("content", new Blob([new Uint8Array(32)]), "big.bin");

    const response = await app.handle(
      new Request("http://localhost/proxy/v1/replicate/files", {
        method: "POST",
        headers: { authorization: "Bearer sk-hc-v1-test" },
        body: form,
      }),
    );

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("upload limit");
  });

  test("accepts an upload at or under the limit and reaches the upstream", async () => {
    const app = buildApp((async () =>
      Response.json({ id: "f1" }, { status: 201 })) as unknown as typeof fetch);

    const form = new FormData();
    form.append("content", new Blob([new Uint8Array(8)]), "small.bin");

    const response = await app.handle(
      new Request("http://localhost/proxy/v1/replicate/files", {
        method: "POST",
        headers: { authorization: "Bearer sk-hc-v1-test" },
        body: form,
      }),
    );

    expect(response.status).toBe(201);
  });
});
