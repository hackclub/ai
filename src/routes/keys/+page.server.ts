import type { PageServerLoad } from "./$types";

import { quickstartCurl } from "#lib/server/examples.ts";
import { requireUser } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const { site } = locals.dashboard;
  const [keys, exampleTemplate] = await Promise.all([
    locals.dashboard.keys(user),
    quickstartCurl(site.baseUrl, site.featuredModel),
  ]);
  return { exampleTemplate, keys };
};
