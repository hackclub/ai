import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  return locals.dashboard.modelCards();
};
