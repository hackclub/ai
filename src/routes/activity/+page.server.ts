import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { parseActivityFilters } from "../../dashboard/read-model";

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const filters = parseActivityFilters(url.searchParams);
  const [recent, options] = await Promise.all([
    locals.dashboard.activity(user, { filters }),
    locals.dashboard.activityFilterOptions(user),
  ]);
  return { recent, filters, options };
};
