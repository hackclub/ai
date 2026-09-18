import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  const catalog = locals.backend.replicateCatalog;
  return { categories: catalog ? await catalog.categories() : [] };
};
