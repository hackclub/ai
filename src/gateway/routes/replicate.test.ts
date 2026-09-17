import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { replicateModelCosts } from "../../config/replicate-models";
import {
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

  test("every configured model has a parseable cost", () => {
    for (const [, cost] of replicateModelCosts) {
      expect(Usd.parse(cost).isNegative()).toBeFalse();
    }
  });
});
