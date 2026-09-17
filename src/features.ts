import { PostHog } from "posthog-node";

export type FeatureFlags = {
  isEnabled(flag: string, distinctId: string): Promise<boolean>;
  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties: Record<string, unknown>): void;
  shutdown(): Promise<void>;
};

export type FeatureFlagOptions = {
  posthogApiKey?: string;
  posthogHost?: string;
  /** Flags forced on regardless of PostHog, e.g. for local development. */
  alwaysEnabled?: string[];
};

/**
 * Feature gating and product analytics through PostHog, matching the previous
 * gateway. Without an API key every flag is off unless listed in
 * `alwaysEnabled`, and events are dropped.
 */
export const createFeatureFlags = (options: FeatureFlagOptions): FeatureFlags => {
  const forced = new Set(options.alwaysEnabled ?? []);
  const client = options.posthogApiKey
    ? new PostHog(options.posthogApiKey, { host: options.posthogHost })
    : null;

  return {
    async isEnabled(flag, distinctId) {
      if (forced.has(flag)) return true;
      if (!client) return false;
      try {
        return (await client.isFeatureEnabled(flag, distinctId)) ?? false;
      } catch {
        return false;
      }
    },
    capture(distinctId, event, properties) {
      client?.capture({ distinctId, event, properties });
    },
    identify(distinctId, properties) {
      client?.identify({ distinctId, properties });
    },
    async shutdown() {
      await client?.shutdown();
    },
  };
};
