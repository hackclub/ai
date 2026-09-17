import type { LayoutServerLoad } from "./$types";

import { dailySpending } from "../analytics/queries";

export const load: LayoutServerLoad = async ({ locals }) => {
  const { backend, user } = locals;
  const env = backend.env;

  const [spending, replicateEnabled] = user
    ? await Promise.all([
        dailySpending(backend.sql, user.billingAccountId),
        backend.features.isEnabled("enable_replicate", user.slackId),
      ])
    : [null, false];

  return {
    user: user
      ? {
          id: user.id,
          slackId: user.slackId,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          isIdvVerified: user.isIdvVerified,
          skipIdv: user.skipIdv,
          agentBannerDismissed: user.agentBannerDismissedAt !== null,
        }
      : null,
    spending,
    replicateEnabled,
    devMode: env.nodeEnv === "development",
    baseUrl: env.baseUrl,
    enforceIdv: env.enforceIdv,
    featuredModel: env.allowedLanguageModels[0] ?? "openai/gpt-4o-mini",
    posthog: env.posthogApiKey
      ? { apiKey: env.posthogApiKey, apiHost: env.posthogApiHost, uiHost: env.posthogUiHost }
      : null,
  };
};
