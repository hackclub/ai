import { describe, expect, test } from "bun:test";

import { InsufficientFundsError, LimitExceededError } from "./errors";
import { Usd } from "./money";
import {
  allocate,
  type Balance,
  compareSources,
  type FundingHold,
  type FundingSource,
  type HoldChange,
  needsCurrentLimitWindows,
  planFinalize,
  planReserve,
} from "./plan";

const usd = (value: string) => Usd.parse(value);

const source = (over: Partial<FundingSource> & { id: string }): FundingSource => ({
  kind: "funding_window",
  priority: 0,
  available: Usd.zero,
  expiresAt: null,
  ...over,
});

const hold = (
  over: Partial<FundingHold> & { id: string; reserved: string },
): FundingHold => ({
  kind: "funding_window",
  priority: 0,
  expiresAt: null,
  held: { reserved: usd(over.reserved), committed: Usd.zero },
  ...over,
});

/** Renders changes as plain strings so expectations read like a ledger. */
const show = (changes: HoldChange[]) =>
  changes.map((change) => {
    const balance = (b: Balance) => `${b.reserved}/${b.committed}`;
    return `${change.kind}:${change.counterId} ${balance(change.before)} -> ${balance(change.after)}`;
  });

describe("compareSources", () => {
  const ids = (sources: FundingSource[]) =>
    [...sources].sort(compareSources).map((s) => s.id);

  test("priority order", () => {
    expect(ids([source({ id: "b", priority: 2 }), source({ id: "a", priority: 1 })])).toEqual([
      "a",
      "b",
    ]);
  });

  test("priority tie breaks on earliest expiry, never-expiring last", () => {
    expect(
      ids([
        source({ id: "later", priority: 1, expiresAt: new Date(2000) }),
        source({ id: "earlier", priority: 1, expiresAt: new Date(1000) }),
        source({ id: "never", priority: 1, expiresAt: null }),
      ]),
    ).toEqual(["earlier", "later", "never"]);
  });

  test("full tie breaks on id", () => {
    expect(
      ids([
        source({ id: "b", priority: 1, expiresAt: new Date(1000) }),
        source({ id: "a", priority: 1, expiresAt: new Date(1000) }),
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("allocate", () => {
  test("exact fit", () => {
    const a = source({ id: "a", available: usd("10") });
    const result = allocate(usd("10"), [a]);

    expect(result.items).toEqual([{ source: a, amount: usd("10") }]);
    expect(result.remaining.isZero()).toBeTrue();
  });

  test("spills from a window to a credit in spending order, whatever the input order", () => {
    const window = source({ id: "w", kind: "funding_window", priority: 100, available: usd("10") });
    const credit = source({ id: "c", kind: "credit_grant", priority: 200, available: usd("10") });
    const result = allocate(usd("15"), [credit, window]);

    expect(result.items).toEqual([
      { source: window, amount: usd("10") },
      { source: credit, amount: usd("5") },
    ]);
    expect(result.remaining.isZero()).toBeTrue();
  });

  test("empty sources are skipped", () => {
    const full = source({ id: "full", available: usd("5") });
    const result = allocate(usd("5"), [source({ id: "empty" }), full]);

    expect(result.items).toEqual([{ source: full, amount: usd("5") }]);
  });

  test("returns what the sources cannot cover", () => {
    const result = allocate(usd("20"), [source({ id: "a", available: usd("5") })]);

    expect(result.items.map((item) => item.amount.toString())).toEqual(["5.000000000000"]);
    expect(result.remaining.toString()).toBe("15.000000000000");
  });

  test("a zero amount allocates nothing", () => {
    const result = allocate(Usd.zero, [source({ id: "a", available: usd("10") })]);

    expect(result.items).toEqual([]);
    expect(result.remaining.isZero()).toBeTrue();
  });
});

describe("planReserve", () => {
  test("holds the estimate in funding and in every limit window", () => {
    const changes = planReserve(usd("0.3"), {
      limits: [
        { id: "day", policyName: "Daily", available: usd("1") },
        { id: "month", policyName: "Monthly", available: usd("5") },
      ],
      sources: [
        source({ id: "w", available: usd("0.2") }),
        source({ id: "c", kind: "credit_grant", priority: 1, available: usd("1") }),
      ],
    });

    expect(show(changes)).toEqual([
      "funding_window:w 0.000000000000/0.000000000000 -> 0.200000000000/0.000000000000",
      "credit_grant:c 0.000000000000/0.000000000000 -> 0.100000000000/0.000000000000",
      "limit_window:day 0.000000000000/0.000000000000 -> 0.300000000000/0.000000000000",
      "limit_window:month 0.000000000000/0.000000000000 -> 0.300000000000/0.000000000000",
    ]);
  });

  test("refuses when any limit window cannot take the estimate", () => {
    expect(() =>
      planReserve(usd("0.3"), {
        limits: [
          { id: "day", policyName: "Daily", available: usd("1") },
          { id: "month", policyName: "Monthly", available: usd("0.29") },
        ],
        sources: [source({ id: "w", available: usd("1") })],
      }),
    ).toThrow(LimitExceededError);
  });

  test("a limit already in overage refuses even a zero estimate", () => {
    expect(() =>
      planReserve(Usd.zero, {
        limits: [{ id: "day", policyName: "Daily", available: usd("-0.1") }],
        sources: [],
      }),
    ).toThrow(LimitExceededError);
  });

  test("refuses when funding cannot cover the estimate", () => {
    expect(() =>
      planReserve(usd("1"), { limits: [], sources: [source({ id: "w", available: usd("0.99") })] }),
    ).toThrow(InsufficientFundsError);
  });
});

describe("planFinalize", () => {
  const noLimits = { limitHolds: [], currentLimits: [] };

  test("commits up to the estimate and returns the unused hold", () => {
    const plan = planFinalize(usd("0.25"), {
      fundingHolds: [
        hold({ id: "w", reserved: "0.2" }),
        hold({ id: "c", kind: "credit_grant", priority: 1, reserved: "0.2" }),
      ],
      sources: [],
      limitHolds: [{ id: "day", held: { reserved: usd("0.4"), committed: Usd.zero } }],
      currentLimits: [],
    });

    expect(show(plan.changes)).toEqual([
      "funding_window:w 0.200000000000/0.000000000000 -> 0.000000000000/0.200000000000",
      "credit_grant:c 0.200000000000/0.000000000000 -> 0.000000000000/0.050000000000",
      "limit_window:day 0.400000000000/0.000000000000 -> 0.000000000000/0.250000000000",
    ]);
    expect(plan.unfunded.isZero()).toBeTrue();
  });

  test("draws a cost above the estimate from available funding, merging into a held source", () => {
    const plan = planFinalize(usd("0.5"), {
      fundingHolds: [hold({ id: "w", reserved: "0.1" })],
      sources: [
        source({ id: "w", available: usd("0.3") }),
        source({ id: "c", kind: "credit_grant", priority: 1, available: usd("1") }),
      ],
      ...noLimits,
    });

    expect(show(plan.changes)).toEqual([
      "funding_window:w 0.100000000000/0.000000000000 -> 0.000000000000/0.400000000000",
      "credit_grant:c 0.000000000000/0.000000000000 -> 0.000000000000/0.100000000000",
    ]);
    expect(plan.unfunded.isZero()).toBeTrue();
  });

  test("books what funding cannot cover as unfunded rather than clamping", () => {
    const plan = planFinalize(usd("1"), {
      fundingHolds: [hold({ id: "w", reserved: "0.1" })],
      sources: [source({ id: "w", available: usd("0.2") })],
      ...noLimits,
    });

    expect(show(plan.changes)).toEqual([
      "funding_window:w 0.100000000000/0.000000000000 -> 0.000000000000/0.300000000000",
    ]);
    expect(plan.unfunded.toString()).toBe("0.700000000000");
  });

  test("a zero cost returns every hold", () => {
    const plan = planFinalize(Usd.zero, {
      fundingHolds: [hold({ id: "w", reserved: "0.1" })],
      sources: [source({ id: "w", available: usd("1") })],
      limitHolds: [{ id: "day", held: { reserved: usd("0.1"), committed: Usd.zero } }],
      currentLimits: [],
    });

    expect(show(plan.changes)).toEqual([
      "funding_window:w 0.100000000000/0.000000000000 -> 0.000000000000/0.000000000000",
      "limit_window:day 0.100000000000/0.000000000000 -> 0.000000000000/0.000000000000",
    ]);
  });

  test("a released reservation is funded from what is available and counted in current limits", () => {
    const plan = planFinalize(usd("0.3"), {
      fundingHolds: [],
      sources: [source({ id: "today", available: usd("1") })],
      limitHolds: [],
      currentLimits: [{ id: "day", policyName: "Daily", available: usd("0.1") }],
    });

    expect(show(plan.changes)).toEqual([
      "funding_window:today 0.000000000000/0.000000000000 -> 0.000000000000/0.300000000000",
      "limit_window:day 0.000000000000/0.000000000000 -> 0.000000000000/0.300000000000",
    ]);
  });

  test("current limit windows are only needed without limit holds and with a real cost", () => {
    const held = [{ id: "day", held: { reserved: usd("0.1"), committed: Usd.zero } }];
    expect(needsCurrentLimitWindows([], usd("0.1"))).toBeTrue();
    expect(needsCurrentLimitWindows([], Usd.zero)).toBeFalse();
    expect(needsCurrentLimitWindows(held, usd("0.1"))).toBeFalse();
  });
});
