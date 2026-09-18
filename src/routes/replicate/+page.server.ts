import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { createReplicateCatalog } from "../../providers/replicate/catalog";

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  const catalog = createReplicateCatalog({ apiKey: locals.backend.env.replicateApiKey ?? "" });
  return { categories: await catalog.categories() };
};
