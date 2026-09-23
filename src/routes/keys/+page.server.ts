import type { PageServerLoad } from "./$types";

import { quickstartCurl } from "#lib/server/examples.ts";
import { requireUser } from "#lib/server/page.ts";
import { listApiKeys } from "../../auth/api-keys";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const env = locals.backend.env;
  const [keys, exampleTemplate] = await Promise.all([
    listApiKeys(locals.backend.sql, user.id),
    quickstartCurl(env.baseUrl, env.featuredModels[0] ?? "openai/gpt-4o-mini"),
  ]);
  return {
    exampleTemplate,
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPreview: `${key.keyPrefix}••••••••`,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    })),
  };
};
