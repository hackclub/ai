import { Hono } from "hono";
import { fetchReplicateCategories } from "../lib/replicate";
import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types";
import { ReplicateModels } from "../views/replicate-models";

const replicate = new Hono<{ Variables: AppVariables }>();

replicate.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const categories = await fetchReplicateCategories();
  return c.html(<ReplicateModels user={user} categories={categories} />);
});

export default replicate;
