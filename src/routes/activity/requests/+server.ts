import { error, json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

import { requireUser } from "#lib/server/page.ts";
import { parseActivityCursor } from "../../../dashboard/read-model";

/** JSON page of older requests for the "Load more" button. */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals);
  const cursor = parseActivityCursor(url.searchParams);
  if (!cursor) error(400, "Missing cursor");
  return json(await locals.dashboard.activity(user, cursor));
};
