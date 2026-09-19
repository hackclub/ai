/**
 * SvelteKit's own same-origin check is disabled in vite.config.js because SDK
 * clients call the proxy without an Origin header. Re-apply the same rule for
 * page routes: form-encoded mutations must come from this origin.
 */
const FORM_CONTENT_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

export const isCrossOriginFormSubmission = (request: Request, origin: string) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!FORM_CONTENT_TYPES.includes(contentType)) return false;
  return request.headers.get("origin") !== origin;
};

/** Paths served by Elysia rather than SvelteKit pages. */
const API_PREFIXES = ["/proxy/", "/api/", "/auth/", "/internal/"];

export const isApiPath = (pathname: string) =>
  pathname === "/up" ||
  pathname === "/proxy" ||
  pathname === "/api" ||
  pathname === "/auth" ||
  pathname === "/internal" ||
  API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
