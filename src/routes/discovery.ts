import { type Context, Hono } from "hono";
import { etag } from "hono/etag";

import {
  allowedEmbeddingModels,
  allowedImageModels,
  allowedLanguageModels,
  env,
} from "../env";
import { buildOpenApiDocument } from "../lib/openapi";
import { buildLlmsTxt, buildRobotsTxt, buildSitemap } from "../lib/site";

/**
 * Machine-readable descriptions of this site: what it is, what URLs exist and
 * what the API can do. Everything here is public and unauthenticated.
 */
const discovery = new Hono();

// Long enough that crawlers and agents aren't refetching constantly, short
// enough that a model-list change shows up the same day.
const CACHE_CONTROL = "public, max-age=3600";

discovery.use("*", etag());

discovery.get("/robots.txt", (c) =>
  c.text(buildRobotsTxt(env.BASE_URL), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": CACHE_CONTROL,
  }),
);

discovery.get("/sitemap.xml", (c) =>
  c.text(buildSitemap(env.BASE_URL), 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": CACHE_CONTROL,
  }),
);

discovery.get("/llms.txt", (c) =>
  c.text(buildLlmsTxt(env.BASE_URL), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": CACHE_CONTROL,
  }),
);

const openApiDocument = () =>
  buildOpenApiDocument({
    baseUrl: env.BASE_URL,
    languageModels: allowedLanguageModels,
    imageModels: allowedImageModels,
    embeddingModels: allowedEmbeddingModels,
  });

const serveOpenApi = (c: Context) =>
  c.json(openApiDocument(), 200, { "Cache-Control": CACHE_CONTROL });

discovery.get("/openapi.json", serveOpenApi);
// Alternate location some agents probe first.
discovery.get("/.well-known/openapi.json", serveOpenApi);

export default discovery;
