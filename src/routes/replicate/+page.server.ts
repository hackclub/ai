import { error } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { createReplicateCatalog } from "../../providers/replicate/catalog";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const enabled = await locals.backend.features.isEnabled("enable_replicate", user.slackId);
  if (!enabled) error(403, "Replicate access is not enabled for your account");

  const catalog = createReplicateCatalog({ apiKey: locals.backend.env.replicateApiKey ?? "" });
  return { categories: await catalog.categories() };
};
