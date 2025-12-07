import { Hono } from "hono";
import type { AppVariables } from "../types";

const docs = new Hono<{ Variables: AppVariables }>();

docs.get("/", (c) => c.redirect("https://docs.ai.hackclub.com"));

export default docs;
