import type { PageServerLoad } from "./$types";

import { quickstartCurl } from "#lib/server/examples.ts";
import { requireUser } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const env = locals.backend.env;
  const [stats, curlExample] = await Promise.all([
    locals.backend.queries.userStats(user.billingAccountId),
    quickstartCurl(env.baseUrl, env.allowedLanguageModels[0] ?? "openai/gpt-4o-mini"),
  ]);
  return { stats, curlExample };
};
