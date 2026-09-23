import { expect, test } from "bun:test";

import { providerRegistry } from "./provider";

const lookup = async () => ({ state: "not_found" as const });

test("providerRegistry returns each key's lookup, and null for none or an unknown key", () => {
  const registry = providerRegistry([
    { key: "with", reconcile: lookup },
    { key: "without", reconcile: null },
  ]);
  expect(registry.lookupFor("with")).toBe(lookup);
  expect(registry.lookupFor("without")).toBeNull();
  expect(registry.lookupFor("unknown")).toBeNull();
});

test("providerRegistry rejects duplicate keys", () => {
  expect(() =>
    providerRegistry([
      { key: "same", reconcile: null },
      { key: "same", reconcile: lookup },
    ]),
  ).toThrow("duplicate provider key");
});
