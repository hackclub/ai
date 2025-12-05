import { Scalar } from "@scalar/hono-api-reference";
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
        origin === "https://ai.hackclub.dev" ||
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
app.get(
  "/reference",
  Scalar({
    url: "/proxy/v1/openapi.json",
    hideModels: true,
    hideClientButton: true,
    hideDarkModeToggle: true,
    customCss: `
      .light-mode,
      .dark-mode {
        --scalar-font: 'Google Sans', ui-sans-serif, system-ui, sans-serif !important;
        --scalar-background-1: #FFF3EB !important;
        --scalar-background-2: #FFFFFF !important;
        --scalar-background-3: #FFFFFF !important;
        --scalar-color-1: #4D000B !important;
        --scalar-color-2: #A67E85 !important;
        --scalar-color-3: #A67E85 !important;
        --scalar-color-accent: #EC3750 !important;
        --scalar-border-color: #F0D4D8 !important;
        --scalar-button-1: #EC3750 !important;
        --scalar-button-1-color: #FFFFFF !important;
        --scalar-button-1-hover: #D62640 !important;
      }
      body {
        background: #FFF3EB !important;
      }
    `,
  }),
);

showRoutes(app);

console.log(`Server running on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 60,
};
