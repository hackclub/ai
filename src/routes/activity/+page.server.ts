import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { activityPage } from "#lib/server/activity.ts";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  return { recent: await activityPage(locals.backend, user) };
};
