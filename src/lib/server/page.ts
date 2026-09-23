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
