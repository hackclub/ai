import { InsufficientFundsError, LimitExceededError } from "./errors";
import { Usd } from "./money";

/**
 * The billing engine's arithmetic, with no database in sight.
 *
 * The engine keeps three kinds of counter, each with `reserved_usd` and
 * `committed_usd` columns:
 *
 * - a **funding window** (one period of a recurring allowance) and a
 *   **credit grant** (one-off credit) supply money;
 * - a **limit window** (one period of a spending cap) only constrains it.
 *
 * A reservation touches a counter through a **hold** row carrying the same
 * two columns, so every counter always equals the sum of its holds (see
 * audit.ts). Every engine operation is therefore a list of `HoldChange`s:
 * the hold moves from `before` to `after`, and its counter moves by the
 * same difference. The planners below decide those changes; holds.ts
 * writes them.
 */

export type FundingKind = "funding_window" | "credit_grant";
export type CounterKind = FundingKind | "limit_window";

export type Balance = { reserved: Usd; committed: Usd };

export const EMPTY_BALANCE: Balance = { reserved: Usd.zero, committed: Usd.zero };

export type HoldChange = {
  kind: CounterKind;
  counterId: string;
  before: Balance;
  after: Balance;
};

/** A funding counter the account can draw on right now. */
export type FundingSource = {
  kind: FundingKind;
  id: string;
  priority: number;
  expiresAt: Date | null;
  /** Granted minus reserved minus committed, across every reservation. */
  available: Usd;
};

/** A funding counter this reservation already holds money in. */
export type FundingHold = {
  kind: FundingKind;
  id: string;
  priority: number;
  expiresAt: Date | null;
  held: Balance;
};

/** A limit window currently in force for the account. */
export type LimitWindow = { id: string; policyName: string; available: Usd };

/** A limit window this reservation already counts against. */
export type LimitHold = { id: string; held: Balance };

type Ordered = { id: string; priority: number; expiresAt: Date | null };

/**
 * Funding is spent lowest priority number first, then earliest expiry
 * (never-expiring last), with id as the final tiebreak so the order is
 * total and deterministic.
 */
export const compareSources = (left: Ordered, right: Ordered) => {
  if (left.priority !== right.priority) return left.priority - right.priority;

  const leftExpiry = left.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightExpiry = right.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

  return left.id.localeCompare(right.id);
};

/**
 * Spreads `amount` across `sources` in spending order. Whatever the
 * sources cannot cover is returned as `remaining`.
 */
export const allocate = (amount: Usd, sources: FundingSource[]) => {
  let remaining = amount;
  const items: { source: FundingSource; amount: Usd }[] = [];

  for (const source of [...sources].sort(compareSources)) {
    if (!remaining.isPositive()) break;
    if (!source.available.isPositive()) continue;
    const taken = Usd.min(remaining, source.available);
    items.push({ source, amount: taken });
    remaining = remaining.subtract(taken);
  }

  return { items, remaining };
};

/**
 * Holds `estimate` in every limit window in force, and in funding sources
 * until it is covered. Throws if any limit or the funding cannot take it,
 * before anything is written.
 */
export function planReserve(
  estimate: Usd,
  { limits, sources }: { limits: LimitWindow[]; sources: FundingSource[] },
): HoldChange[] {
  for (const limit of limits) {
    if (limit.available.lessThan(estimate)) {
      throw new LimitExceededError(limit.policyName);
    }
  }

  const funding = allocate(estimate, sources);
  if (funding.remaining.isPositive()) throw new InsufficientFundsError();

  const changes: HoldChange[] = [
    ...funding.items.map(({ source, amount }) => ({
      kind: source.kind,
      counterId: source.id,
      before: EMPTY_BALANCE,
      after: { reserved: amount, committed: Usd.zero },
    })),
    ...limits.map((limit) => ({
      kind: "limit_window" as const,
      counterId: limit.id,
      before: EMPTY_BALANCE,
      after: { reserved: estimate, committed: Usd.zero },
    })),
  ];

  assertBalanced("reserve", {
    expected: estimate,
    actual: fundingDelta(changes, "reserved"),
  });
  return changes;
}

/**
 * A reservation holding no limit window (a zero estimate, or holds the
 * expiry sweeper released) is counted against the limit windows in force
 * when it finalizes. Only then does the engine need to read them.
 */
export const needsCurrentLimitWindows = (limitHolds: LimitHold[], actual: Usd) =>
  limitHolds.length === 0 && actual.isPositive();

/**
 * Converts every hold into its share of `actual`:
 *
 * 1. Funding holds are committed in spending order, each up to what it
 *    reserved. The unused rest of each reservation is returned.
 * 2. Anything above the estimate is drawn from the account's available
 *    funding, as a new charge.
 * 3. Whatever funding cannot cover is `unfunded`: still charged and
 *    recorded, never clamped.
 * 4. Every limit window counts the full `actual`, even past its limit;
 *    the generated `overage_usd` column exposes the excess.
 */
export function planFinalize(
  actual: Usd,
  input: {
    fundingHolds: FundingHold[];
    sources: FundingSource[];
    limitHolds: LimitHold[];
    /** Only read when `needsCurrentLimitWindows`; otherwise empty. */
    currentLimits: LimitWindow[];
  },
): { changes: HoldChange[]; unfunded: Usd } {
  const funding = new Map<string, HoldChange>();
  let remaining = actual;

  for (const hold of [...input.fundingHolds].sort(compareSources)) {
    const committed = Usd.min(remaining, hold.held.reserved);
    funding.set(`${hold.kind}:${hold.id}`, {
      kind: hold.kind,
      counterId: hold.id,
      before: hold.held,
      after: { reserved: Usd.zero, committed: hold.held.committed.add(committed) },
    });
    remaining = remaining.subtract(committed);
  }

  if (remaining.isPositive()) {
    const extra = allocate(remaining, input.sources);
    for (const { source, amount } of extra.items) {
      const key = `${source.kind}:${source.id}`;
      const existing = funding.get(key);
      if (existing) {
        // The source this reservation already held still has room.
        existing.after = {
          reserved: existing.after.reserved,
          committed: existing.after.committed.add(amount),
        };
      } else {
        funding.set(key, {
          kind: source.kind,
          counterId: source.id,
          before: EMPTY_BALANCE,
          after: { reserved: Usd.zero, committed: amount },
        });
      }
    }
    remaining = extra.remaining;
  }

  const limits: HoldChange[] =
    input.limitHolds.length > 0
      ? input.limitHolds.map((hold) => ({
          kind: "limit_window",
          counterId: hold.id,
          before: hold.held,
          after: { reserved: Usd.zero, committed: hold.held.committed.add(actual) },
        }))
      : input.currentLimits.map((limit) => ({
          kind: "limit_window",
          counterId: limit.id,
          before: EMPTY_BALANCE,
          after: { reserved: Usd.zero, committed: actual },
        }));

  const changes = [...funding.values(), ...limits];
  const unfunded = remaining;

  assertBalanced("finalize", {
    expected: actual,
    actual: fundingDelta(changes, "committed").add(unfunded),
  });
  if (changes.some((change) => !change.after.reserved.isZero())) {
    throw new Error("Billing plan for finalize left money reserved");
  }
  return { changes, unfunded };
}

const fundingDelta = (changes: HoldChange[], field: keyof Balance) =>
  Usd.sum(
    changes
      .filter((change) => change.kind !== "limit_window")
      .map((change) => change.after[field].subtract(change.before[field])),
  );

/** A planner bug must fail the transaction, never write unbalanced money. */
function assertBalanced(
  operation: string,
  { expected, actual }: { expected: Usd; actual: Usd },
) {
  if (!expected.equals(actual)) {
    throw new Error(
      `Billing plan for ${operation} does not balance: ${actual} != ${expected}`,
    );
  }
}
