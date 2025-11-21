import "./instrument"; // Sentry
import { Hono } from "hono";
import * as Sentry from "@sentry/bun";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { csrf } from "hono/csrf";
import { requestId } from "hono/request-id";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import type { RequestIdVariables } from "hono/request-id";
import { env } from "./env";
import auth from "./routes/auth";
import proxy from "./routes/proxy";
import api from "./routes/api";
import docs from "./routes/docs";
import dashboard from "./routes/dashboard";
import global from "./routes/global";
import { runMigrations } from "./migrate";
import type { AppVariables } from "./types";
import { dns } from "bun";

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
app.route("/global", global);

console.log(`Server running on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 60,
};
