import { error, json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

import { requireUser } from "#lib/server/page.ts";

export const GET: RequestHandler = async ({ locals, params }) => {
  const user = requireUser(locals);
  const request = await locals.dashboard.activityRequest(user, params.id);
  if (!request) error(404, "Request not found");
  return json(request);
};
