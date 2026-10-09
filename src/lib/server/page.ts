import { error, redirect } from "@sveltejs/kit";

import { type SessionUser, sessionAccess } from "../../auth/sessions";
import { BANNED_MESSAGE } from "../../auth/users";

/** Signed-in user for a dashboard page, or a redirect to the home page. */
export const requireUser = (locals: Pick<App.Locals, "user">): SessionUser => {
  const access = sessionAccess(locals.user);
  if (access.ok) return access.user;
  if (access.reason === "banned") error(403, BANNED_MESSAGE);
  redirect(302, "/");
};

/**
 * Signed-in admin for an `/admin` page. Everyone else gets a 404, so the
 * pages do not advertise themselves. Each page's load calls this: layout
 * loads run in parallel with page loads and cannot guard them.
 */
export const requireAdmin = (locals: Pick<App.Locals, "user">): SessionUser => {
  const user = requireUser(locals);
  if (!user.isAdmin) error(404, "Not found");
  return user;
};
