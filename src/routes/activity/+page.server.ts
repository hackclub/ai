import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { activityPage } from "#lib/server/activity.ts";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const [stats, recent] = await Promise.all([
    locals.backend.queries.userStats(user.billingAccountId),
    activityPage(locals.backend, user),
  ]);
  return { stats, recent };
};
