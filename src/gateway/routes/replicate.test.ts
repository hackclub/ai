import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { allowedReplicateModels } from "../../config/replicate-models";
import type { ReplicatePricing } from "../../providers/replicate/pricing";
import {
  meterPrediction,
  resolveModelReference,
  rewriteUpstreamLinks,
  validateModelAccess,
  validateVersionAccess,
  versionFromModelName,
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
    if (completion.state === "uncertain") expect(completion.reason).toContain("p3");
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
    if (completion.state === "uncertain") expect(completion.reason).toBe("lookup exploded");
  });
});
