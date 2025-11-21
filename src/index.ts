import { Scalar } from "@scalar/hono-api-reference";
import "./instrument"; // Sentry
import * as Sentry from "@sentry/bun";
import { dns } from "bun";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { csrf } from "hono/csrf";
import { showRoutes } from "hono/dev";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { RequestIdVariables } from "hono/request-id";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { trimTrailingSlash } from "hono/trailing-slash";

import { env } from "./env";
import { runMigrations } from "./migrate";
import api from "./routes/api";
import auth from "./routes/auth";
import dashboard from "./routes/dashboard";
import docs from "./routes/docs";
import globalRoute from "./routes/global";
import proxy from "./routes/proxy";
import type { AppVariables } from "./types";

await runMigrations();
dns.prefetch(env.OPENAI_API_URL, 443);

const app = new Hono<{ Variables: AppVariables & RequestIdVariables }>();

app.use("*", secureHeaders());
app.use(
  "/proxy/*",
  bodyLimit({
    maxSize: 20 * 1024 * 1024,
    onError: () => {
      throw new HTTPException(413, { message: "Request too large" });
    },
  }),
);
app.use("/proxy/*", timeout(120000));

app.use("/*", requestId(), trimTrailingSlash());
app.use("/*", csrf({ origin: env.BASE_URL }));

if (env.NODE_ENV === "development") {
  app.use("*", logger());
}

app.use("/*", serveStatic({ root: "./public" }));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("Unhandled error:", err);
  Sentry.captureException(err);
  return c.json({ error: "Internal server error" }, 500);
});

app.route("/", dashboard);
app.route("/auth", auth);
app.route("/proxy", proxy);
app.route("/api", api);
app.route("/docs", docs);
app.route("/global", globalRoute);

// docs UI - generally at /docs, but I dropped it at /ui for now
app.get(
  "/ui",
  Scalar({
    url: "/proxy/openapi.json",
    theme: "default",
    hideModels: true,
    hideClientButton: true,
  }),
);

showRoutes(app);

console.log(`Server running on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 60,
};
