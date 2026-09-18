import { error, json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { activityPage } from "#lib/server/activity.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON page of older requests for the "Load more" button. */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals);
  const before = url.searchParams.get("before");
  const beforeId = url.searchParams.get("beforeId");
  const beforeAt = before ? new Date(before) : null;
  if (!beforeAt || Number.isNaN(beforeAt.getTime()) || !beforeId || !UUID.test(beforeId)) {
    error(400, "Missing cursor");
  }
  // Normalized to ISO 8601 so ClickHouse parses exactly what JavaScript did.
  return json(
    await activityPage(locals.backend, user, { before: beforeAt.toISOString(), beforeId }),
  );
};
