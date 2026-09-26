import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { parseGlobalRange } from "../../dashboard/read-model";

export const load: PageServerLoad = async ({ locals, url }) => {
  requireUser(locals);
  return locals.dashboard.globalUsage(parseGlobalRange(url.searchParams.get("range")));
};
