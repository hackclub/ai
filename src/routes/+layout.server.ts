import type { LayoutServerLoad } from "./$types";

import { dailySpending } from "../analytics/queries";

export const load: LayoutServerLoad = async ({ locals }) => {
  const { backend, user } = locals;
  const env = backend.env;

  const spending = user ? await dailySpending(backend.sql, user.billingAccountId) : null;

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
    devMode: env.nodeEnv === "development",
    baseUrl: env.baseUrl,
    enforceIdv: env.enforceIdv,
    featuredModel: env.featuredModels[0] ?? "openai/gpt-4o-mini",
  };
};
