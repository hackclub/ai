import type { PageServerLoad } from "./$types";

import { requireAdmin } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAdmin(locals);
  const query = url.searchParams.get("q") ?? "";
  return { query, users: await locals.dashboard.admin.searchUsers(query) };
};
