import { Hono } from "hono";
import { Docs } from "../views/docs";
import { allowedLanguageModels, allowedEmbeddingModels } from "../env";
import type { AppVariables } from "../types";
import { optionalAuth } from "../middleware/auth";

const docs = new Hono<{ Variables: AppVariables }>();

docs.get("/", optionalAuth, async (c) => {
  const user = c.get("user");

  return c.html(
    <Docs user={user} />,
  );
});

export default docs;
