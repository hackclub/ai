import { error, redirect } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

import { requireUser } from "#lib/server/page.ts";

export const GET: RequestHandler = async ({ locals, params }) => {
  requireUser(locals);
  const cover = await locals.dashboard.replicateCover(params.owner, params.name);
  if (!cover) error(404, "No cover");
  if ("redirect" in cover) redirect(302, cover.redirect);
  return new Response(cover.image, { headers: { "cache-control": "private, max-age=86400" } });
};
