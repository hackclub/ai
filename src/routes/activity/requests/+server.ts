import { error, json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { activityPage } from "#lib/server/activity.ts";

/** JSON page of older requests for the "Load more" button. */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals);
  const before = url.searchParams.get("before");
  const beforeId = url.searchParams.get("beforeId");
  if (!before || !beforeId || Number.isNaN(new Date(before).getTime())) {
    error(400, "Missing cursor");
  }
  return json(await activityPage(locals.backend, user, { before, beforeId }));
};
