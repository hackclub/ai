import type { Handle } from "@sveltejs/kit/hooks";

import { SESSION_COOKIE, cookieName, cookieValue, sessionUser } from "./auth/sessions";
import { loadEnv } from "./env";
import { installShutdownHandlers, startBackend } from "./lifecycle";
import { type Backend, createBackend } from "./server";

/**
 * The Elysia backend is created once per process. Vite's dev server can
 * re-evaluate this module on change, so the instance is kept on globalThis.
 */
const registry = globalThis as typeof globalThis & {
  __hcaiBackend?: Backend;
  __hcaiBackendStarted?: Promise<void>;
};

const backend = (registry.__hcaiBackend ??= createBackend(loadEnv()));
// A start failure is not fatal here: pages still work, /up answers 503, and
// the error is logged and reported. See src/lifecycle.ts.
registry.__hcaiBackendStarted ??= startBackend(backend).started;
// adapter-bun owns the listener; the settlement drain in Backend.shutdown
// covers in-flight requests.
installShutdownHandlers(backend);


/**
 * SvelteKit's own same-origin check is disabled in vite.config.js because SDK
 * clients call the proxy without an Origin header. Re-apply the same rule for
 * page routes: form-encoded mutations must come from this origin.
 */
const FORM_CONTENT_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

const isCrossOriginFormSubmission = (request: Request, origin: string) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!FORM_CONTENT_TYPES.includes(contentType)) return false;
  return request.headers.get("origin") !== origin;
};

/** Paths served by Elysia rather than SvelteKit pages. */
const API_PREFIXES = ["/proxy/", "/api/", "/auth/", "/internal/"];

const isApiPath = (pathname: string) =>
  pathname === "/up" ||
  pathname === "/proxy" ||
  pathname === "/api" ||
  pathname === "/auth" ||
  pathname === "/internal" ||
  API_PREFIXES.some((prefix) => pathname.startsWith(prefix));

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  if (isApiPath(pathname)) {
    // Resolves once per process; a no-op afterwards. Startup failure is not
    // fatal here (pages still work), and /up reports it.
    await registry.__hcaiBackendStarted;
    return backend.app.handle(event.request);
  }

  if (isCrossOriginFormSubmission(event.request, event.url.origin)) {
    return Response.json({ error: "Cross-site form submissions are forbidden" }, { status: 403 });
  }

  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return Response.redirect("https://docs.ai.hackclub.com", 302);
  }

  event.locals.backend = backend;
  event.locals.user = await sessionUser(
    backend.sql,
    cookieValue(
      event.request.headers.get("cookie"),
      cookieName(SESSION_COOKIE, backend.env.nodeEnv === "production"),
    ),
  );
  return resolve(event);
};
