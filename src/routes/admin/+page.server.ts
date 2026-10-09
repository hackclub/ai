import { redirect } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

import { requireAdmin } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  requireAdmin(locals);
  redirect(302, "/admin/users");
};
