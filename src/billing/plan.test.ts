import { describe, expect, test } from "bun:test";

import { LimitExceededError } from "./errors";
import { Usd } from "./money";
import {
  type Balance,
  compareSources,
  type FundingHold,
  type FundingSource,
  type HoldChange,
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

test("compareSources orders by priority, then earliest expiry (never last), then id", () => {
  const sources = [
    source({ id: "last", priority: 2 }),
    source({ id: "never", priority: 1, expiresAt: null }),
    source({ id: "later", priority: 1, expiresAt: new Date(2000) }),
    source({ id: "b", priority: 1, expiresAt: new Date(1000) }),
    source({ id: "a", priority: 1, expiresAt: new Date(1000) }),
  ];
  expect(sources.sort(compareSources).map((s) => s.id)).toEqual(["a", "b", "later", "never", "last"]);
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
});

describe("planFinalize", () => {
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
});
