import { error } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

import { requireAdmin } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals, params }) => {
  const admin = requireAdmin(locals);
  const page = await locals.dashboard.admin.user(params.id);
  if (!page) error(404, "User not found");
  return { ...page, isSelf: admin.id === page.user.id };
};
