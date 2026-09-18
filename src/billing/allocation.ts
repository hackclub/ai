import type { AvailableSourceRow, ExistingHoldRow } from "./locks";
import { Usd } from "./money";

/**
 * Pure arithmetic for spreading a reservation or charge across funding
 * sources. Sources are consumed in priority order, earliest expiry first,
 * id as the final tiebreak. Amounts are bigint atoms (see money.ts); no
 * floating point ever enters here.
 */

export type FundingSource = {
  kind: "window" | "credit";
  id: string;
  priority: number;
  availableAtoms: bigint;
  expiresAt: Date | null;
};

export type ExistingHold = FundingSource & {
  reservedAtoms: bigint;
};

export const minAtoms = (left: bigint, right: bigint) =>
  left < right ? left : right;

export const compareSources = (left: FundingSource, right: FundingSource) => {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  const leftExpiry = left.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightExpiry = right.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

  return left.id.localeCompare(right.id);
};

export const toFundingSources = (
  windows: AvailableSourceRow[],
  credits: AvailableSourceRow[],
): FundingSource[] => {
  return [
    ...windows.map((row) => ({
      kind: "window" as const,
      id: row.id,
      priority: row.priority,
      availableAtoms: Usd.parse(row.available_usd).toAtoms(),
      expiresAt: row.expires_at,
    })),
    ...credits.map((row) => ({
      kind: "credit" as const,
      id: row.id,
      priority: row.priority,
      availableAtoms: Usd.parse(row.available_usd).toAtoms(),
      expiresAt: row.expires_at,
    })),
  ].sort(compareSources);
};

export const allocate = (amountAtoms: bigint, sources: FundingSource[]) => {
  let remainingAtoms = amountAtoms;
  const items: {
    source: FundingSource;
    amountAtoms: bigint;
  }[] = [];

  for (const source of sources) {
    if (remainingAtoms === 0n) break;
    const amount = minAtoms(remainingAtoms, source.availableAtoms);
    if (amount <= 0n) continue;
    items.push({ source, amountAtoms: amount });
    remainingAtoms -= amount;
  }

  return { items, remainingAtoms };
};

export const toExistingHolds = (
  windows: ExistingHoldRow[],
  credits: ExistingHoldRow[],
): ExistingHold[] => {
  return [
    ...windows.map((row) => ({
      kind: "window" as const,
      id: row.id,
      priority: row.priority,
      availableAtoms: 0n,
      reservedAtoms: Usd.parse(row.reserved_usd).toAtoms(),
      expiresAt: row.expires_at,
    })),
    ...credits.map((row) => ({
      kind: "credit" as const,
      id: row.id,
      priority: row.priority,
      availableAtoms: 0n,
      reservedAtoms: Usd.parse(row.reserved_usd).toAtoms(),
      expiresAt: row.expires_at,
    })),
  ].sort(compareSources);
};
