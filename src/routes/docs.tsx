import { Hono } from "hono";
import { optionalAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { Docs } from "../views/docs";

const docs = new Hono<{ Variables: AppVariables }>();

docs.get("/", optionalAuth, async (c) => {
  const user = c.get("user");

  return c.html(<Docs user={user} />);
});

export default docs;
