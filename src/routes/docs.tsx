import { Hono } from "hono";
import { Docs } from "../views/docs";
import { getAllowedLanguageModels, getAllowedEmbeddingModels } from "../env";
import type { AppVariables } from "../types";
import { optionalAuth } from "../middleware/auth";

const docs = new Hono<{ Variables: AppVariables }>();

docs.get("/", optionalAuth, async (c) => {
  const user = c.get("user");
  const allowedLanguageModels = getAllowedLanguageModels();
  const allowedEmbeddingModels = getAllowedEmbeddingModels();

  return c.html(
    <Docs
      user={user}
      allowedLanguageModels={allowedLanguageModels}
      allowedEmbeddingModels={allowedEmbeddingModels}
    />,
  );
});

export default docs;
