import { error, redirect } from "@sveltejs/kit";

import type { SessionUser } from "../../auth/sessions";

/** Signed-in user for a dashboard page, or a redirect to the home page. */
export const requireUser = (locals: App.Locals): SessionUser => {
  if (!locals.user) redirect(302, "/");
  if (locals.user.isBanned) error(403, "You are banned from using this service.");
  return locals.user;
};
