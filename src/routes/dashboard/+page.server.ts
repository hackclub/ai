import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  return { stats: await locals.backend.queries.userStats(user.billingAccountId) };
};
