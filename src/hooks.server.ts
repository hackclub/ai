import type { Handle, ServerInit } from "@sveltejs/kit/hooks";

import { SESSION_COOKIE, cookieName, cookieValue, sessionUser } from "./auth/sessions";
import { loadEnv } from "./env";
import { isApiPath, isCrossOriginFormSubmission } from "./hooks.paths";
import { log } from "./log";
import { type Backend, createBackend } from "./server";

/**
 * The Elysia backend is created once per process. Vite's dev server can
 * re-evaluate this module on change, so the instance is kept on globalThis.
 */
const registry = globalThis as typeof globalThis & {
  __hcaiBackend?: Backend;
  __hcaiBackendStarted?: Promise<void>;
  __hcaiShutdownInstalled?: boolean;
};

const backend = (registry.__hcaiBackend ??= createBackend(loadEnv()));

/**
 * Runs before the first request. The dashboard is useless without the
 * backend, so a start failure exits like src/index.ts does; start() has
 * already logged and reported it.
 */
export const init: ServerInit = async () => {
  try {
    await (registry.__hcaiBackendStarted ??= backend.start());
  } catch {
    await backend.shutdown().catch(() => {});
    process.exit(1);
  }
};

// adapter-bun handles SIGTERM/SIGINT itself: it stops listening, waits for
// in-flight requests (up to SHUTDOWN_TIMEOUT), then emits this event. Closing
// the pools any earlier would fail the requests it is still draining. The
// dev server never emits it; its process simply exits.
if (!registry.__hcaiShutdownInstalled) {
  registry.__hcaiShutdownInstalled = true;
  process.once("sveltekit:shutdown" as NodeJS.Signals, (signal) => {
    log.info({ signal }, "shutting down");
    backend.shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error({ err }, "shutdown failed");
        process.exit(1);
      },
    );
  });
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  if (isApiPath(pathname)) return backend.app.handle(event.request);

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
