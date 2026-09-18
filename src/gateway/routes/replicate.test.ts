import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { allowedReplicateModels } from "../../config/replicate-models";
import type { ReplicatePricing } from "../../providers/replicate/pricing";
import {
  meterPrediction,
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

  test("every allowlisted version belongs to an allowlisted model", () => {
    for (const model of Object.values(allowedReplicateModelVersions)) {
      expect(allowedReplicateModels).toContain(model);
    }
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
