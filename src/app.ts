import { type AnyElysia, Elysia } from "elysia";

import { HttpError } from "./gateway/http-error";
import { type ProxyDependencies, proxyRoutes } from "./gateway/proxy";

type FrameworkError = { status: number; problemTitle: string };

/**
 * Elysia's routing and parsing failures (404, 400, ...) are "problem" errors
 * with a numeric status. They are not instances of the exported HTTPError
 * class, so match them structurally.
 */
const frameworkError = (error: unknown): FrameworkError | null => {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as Partial<FrameworkError> & { problemType?: unknown };
  return typeof candidate.status === "number" &&
    typeof candidate.problemType === "string"
    ? {
        status: candidate.status,
        problemTitle:
          typeof candidate.problemTitle === "string"
            ? candidate.problemTitle
            : "Request failed",
      }
    : null;
};

export type AppOptions = {
  proxy: ProxyDependencies;
  /** Additional route groups (auth, dashboard API, webhooks, providers). */
  routes?: AnyElysia[];
  /** Health handler; defaults to a static OK. */
  health?: () => Promise<Response> | Response;
  onError?: (error: unknown) => void;
};

/**
 * Assembles the HTTP application from explicit dependencies so tests can
 * drive it in-process with fakes via `app.handle(new Request(...))`.
 */
export const createApp = (options: AppOptions): AnyElysia => {
  const base = new Elysia()
    .error(({ error }) => {
      if (error instanceof HttpError) return error.toResponse();
      const framework = frameworkError(error);
      if (framework) {
        return Response.json(
          {
            error:
              framework.status === 404 ? "Not found" : framework.problemTitle,
          },
          { status: framework.status },
        );
      }
      options.onError?.(error);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    })
    .get("/up", () => options.health?.() ?? { ok: true })
    .use(proxyRoutes(options.proxy));
  return (options.routes ?? []).reduce<AnyElysia>(
    (app, routes) => app.use(routes),
    base,
  );
};

export type App = AnyElysia;
