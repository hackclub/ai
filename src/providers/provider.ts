import type { ChargeLookup, ProviderLookups } from "../billing/reconciliation";

/** Everything the rest of the system needs to know about paying one provider. */
export type ProviderModule = {
  /** The `billing_reservations.provider` value this module's requests reserve under. */
  key: string;
  /**
   * How reconciliation settles a pending reservation later, or null when the
   * provider has no lookup: the hold is then released after the max age
   * without a charge.
   */
  reconcile: ChargeLookup | null;
};

export const providerRegistry = (modules: ProviderModule[]): ProviderLookups => {
  const byKey = new Map(modules.map((module) => [module.key, module]));
  if (byKey.size !== modules.length) throw new Error("duplicate provider key");
  return { lookupFor: (provider) => byKey.get(provider)?.reconcile ?? null };
};
