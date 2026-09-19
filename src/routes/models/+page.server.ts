import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { groupedModelCards } from "#lib/server/models.ts";

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  return groupedModelCards(locals.backend);
};
