import "./instrument"; // Sentry
import * as Sentry from "@sentry/bun";
import { dns } from "bun";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { showRoutes } from "hono/dev";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { RequestIdVariables } from "hono/request-id";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";

import { env } from "./env";
import { runMigrations } from "./migrate";
import api from "./routes/api";
import auth from "./routes/auth";
import dashboard from "./routes/dashboard";
import docs from "./routes/docs";
import global from "./routes/global";
import internal from "./routes/internal";
import proxy from "./routes/proxy";
import type { AppVariables } from "./types";

await runMigrations();
dns.prefetch(env.OPENAI_API_URL, 443);

const app = new Hono<{ Variables: AppVariables & RequestIdVariables }>();

app.use("*", secureHeaders());
app.use("/*", requestId(), trimTrailingSlash());
app.use("/*", csrf({ origin: env.BASE_URL }));
app.use(
  "/proxy/v1/*",
  cors({
    origin: (origin) => {
      if (
        origin === env.BASE_URL ||
        origin === "https://docs.hackclub.dev" ||
        origin === "https://docs.ai.hackclub.com" ||
        (env.NODE_ENV === "development" &&
          origin.startsWith("http://localhost"))
      ) {
        return origin;
      }
      return env.BASE_URL; // Default to production domain
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Title"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  }),
);

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
app.route("/proxy/v1", proxy);
app.route("/api", api);
app.route("/docs", docs);
app.route("/global", global);
app.route("/internal", internal);

showRoutes(app);

console.log(`Server running on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 60,
};
