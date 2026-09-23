import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  const { dashboard, user } = locals;
  const { site } = dashboard;

  const spending = user ? await dashboard.spending(user) : null;

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
    devMode: site.devMode,
    baseUrl: site.baseUrl,
    enforceIdv: site.enforceIdv,
    featuredModel: site.featuredModel,
  };
};
