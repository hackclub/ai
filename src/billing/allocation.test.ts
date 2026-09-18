import { describe, expect, test } from "bun:test";

import {
  allocate,
  compareSources,
  type FundingSource,
  toExistingHolds,
  toFundingSources,
} from "./allocation";
import { Usd } from "./money";

const source = (over: Partial<FundingSource> & { id: string }): FundingSource => ({
  kind: "window",
  priority: 0,
  availableAtoms: 0n,
  expiresAt: null,
  ...over,
});

describe("compareSources", () => {
  test("priority order", () => {
    const sources = [
      source({ id: "b", priority: 2, availableAtoms: 10n }),
      source({ id: "a", priority: 1, availableAtoms: 10n }),
    ];

    expect([...sources].sort(compareSources).map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
  });

  test("priority tie breaks on earliest expiry", () => {
    const sources = [
      source({ id: "later", priority: 1, expiresAt: new Date(2000) }),
      source({ id: "earlier", priority: 1, expiresAt: new Date(1000) }),
      source({ id: "never", priority: 1, expiresAt: null }),
    ];

    expect([...sources].sort(compareSources).map((s) => s.id)).toEqual([
      "earlier",
      "later",
      "never",
    ]);
  });

  test("full tie breaks on id", () => {
    const sources = [
      source({ id: "b", priority: 1, expiresAt: new Date(1000) }),
      source({ id: "a", priority: 1, expiresAt: new Date(1000) }),
    ];

    expect([...sources].sort(compareSources).map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("allocate", () => {
  test("exact fit", () => {
    const result = allocate(10n, [source({ id: "a", availableAtoms: 10n })]);

    expect(result.items).toEqual([
      { source: source({ id: "a", availableAtoms: 10n }), amountAtoms: 10n },
    ]);
    expect(result.remainingAtoms).toBe(0n);
  });

  test("spill from window to credit", () => {
    const window = source({ id: "a", kind: "window", availableAtoms: 10n });
    const credit = source({ id: "c", kind: "credit", availableAtoms: 10n });
    const result = allocate(15n, [window, credit]);

    expect(result.items).toEqual([
      { source: window, amountAtoms: 10n },
      { source: credit, amountAtoms: 5n },
    ]);
    expect(result.remainingAtoms).toBe(0n);
  });

  test("zero-available sources are skipped", () => {
    const empty = source({ id: "empty" });
    const full = source({ id: "full", availableAtoms: 5n });
    const result = allocate(5n, [empty, full]);

    expect(result.items).toEqual([{ source: full, amountAtoms: 5n }]);
    expect(result.remainingAtoms).toBe(0n);
  });

  test("unfunded remainder", () => {
    const a = source({ id: "a", availableAtoms: 5n });
    const result = allocate(20n, [a]);

    expect(result.items).toEqual([{ source: a, amountAtoms: 5n }]);
    expect(result.remainingAtoms).toBe(15n);
  });

  test("zero amount allocates nothing", () => {
    const result = allocate(0n, [source({ id: "a", availableAtoms: 10n })]);

    expect(result.items).toEqual([]);
    expect(result.remainingAtoms).toBe(0n);
  });
});

describe("toFundingSources", () => {
  test("parses and sorts", () => {
    const windows = [
      { id: "w", priority: 5, available_usd: "1.5", expires_at: null },
    ];
    const credits = [
      { id: "c", priority: 1, available_usd: "0.25", expires_at: new Date(0) },
    ];

    const sources = toFundingSources(windows, credits);

    expect(sources[0].id).toBe("c");
    expect(sources[0].availableAtoms).toBe(Usd.parse("0.25").toAtoms());
  });
});

describe("toExistingHolds", () => {
  test("carries reservedAtoms and zero available", () => {
    const windows = [
      {
        id: "w",
        priority: 1,
        reserved_usd: "0.01",
        expires_at: null,
      },
    ];

    const holds = toExistingHolds(windows, []);

    expect(holds[0].reservedAtoms).toBe(Usd.parse("0.01").toAtoms());
    expect(holds[0].availableAtoms).toBe(0n);
  });
});
