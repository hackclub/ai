import { Usd } from "../../billing/money";
import type { ProviderModule } from "../provider";

export const EXA = "exa";

/** `costDollars.total` from an Exa response, or null. */
export const exaCost = (body: unknown): Usd | null => {
  if (body === null || typeof body !== "object") return null;
  const cost = (body as { costDollars?: { total?: unknown } }).costDollars?.total;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  return Usd.fromNumber(cost);
};

export const exaRequestId = (body: unknown) =>
  body !== null && typeof body === "object" && typeof (body as { requestId?: unknown }).requestId === "string"
    ? (body as { requestId: string }).requestId
    : null;

/** No lookup: a pending Exa hold is released after the max age without a charge. */
export const exaProvider: ProviderModule = { key: EXA, reconcile: null };
