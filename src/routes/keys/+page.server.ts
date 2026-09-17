import type { PageServerLoad } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { listApiKeys } from "../../gateway/keys-api";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const keys = await listApiKeys(locals.backend.sql, user.id);
  return {
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPreview: `${key.keyPrefix}••••••••`,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    })),
  };
};
