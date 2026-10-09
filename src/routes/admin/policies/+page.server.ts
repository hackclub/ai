import type { PageServerLoad } from "./$types";

import { requireAdmin } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  requireAdmin(locals);
  return { policies: await locals.dashboard.admin.globalPolicies() };
};
