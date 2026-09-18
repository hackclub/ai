export type FeatureFlags = {
  isEnabled(flag: string, distinctId: string): Promise<boolean>;
};

export type FeatureFlagOptions = {
  /** Flags that are on for every user, e.g. enable_exa. */
  enabled?: string[];
};

/**
 * Feature gating from configuration alone. PostHog was removed, so a flag is
 * either on for everyone (listed in `enabled`) or off; the `distinctId`
 * argument is kept so a per-user source can be reintroduced without touching
 * the routes.
 */
export const createFeatureFlags = (options: FeatureFlagOptions): FeatureFlags => {
  const enabled = new Set(options.enabled ?? []);
  return {
    async isEnabled(flag) {
      return enabled.has(flag);
    },
  };
};
