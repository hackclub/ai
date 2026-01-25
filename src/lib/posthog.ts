import { PostHog } from "posthog-node";
import { env } from "../env";
import type { User } from "../types";

const posthog = new PostHog(env.POSTHOG_API_KEY, {
  host: env.POSTHOG_API_HOST,
});

export const identifyUser = (user: User) => {
  posthog.identify({
    distinctId: user.slackId,
    properties: {
      userId: user.id,
      email: user.email,
      name: user.name,
      isIdvVerified: user.isIdvVerified,
    },
  });
};

export const captureEvent = (
  user: User,
  event: string,
  properties?: Record<string, unknown>,
) => {
  posthog.capture({
    distinctId: user.slackId,
    event,
    properties: {
      userId: user.id,
      email: user.email,
      name: user.name,
      ...properties,
    },
  });
};

export const isFeatureEnabled = async (
  user: User,
  flag: string,
): Promise<boolean> => {
  return (await posthog.isFeatureEnabled(flag, user.slackId)) ?? false;
};
