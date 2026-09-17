import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  const [globalStats, modelStats] = await Promise.all([
    locals.backend.queries.globalStats(),
    locals.backend.queries.modelStats(),
  ]);
  return { globalStats, modelStats };
};
