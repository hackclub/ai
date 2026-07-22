import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../types";

export async function requireAdmin(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  const user = c.get("user");

  if (!user?.isAdmin) {
    throw new HTTPException(403, { message: "Admin access required" });
  }

  await next();
}
