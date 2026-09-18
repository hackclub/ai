import { HttpError } from "./http-error";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects browser-originated cross-site mutations on cookie-authenticated
 * routes. SvelteKit's global check is disabled (vite.config.js) because SDK
 * clients call /proxy without an Origin header, so this is applied only where
 * the session cookie is the credential. Requests carrying neither `Origin`
 * nor `Sec-Fetch-Site` (non-browser clients) pass.
 */
export const assertSameOrigin = (request: Request, baseUrl: string) => {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const expected = new URL(baseUrl).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "Cross-site requests are forbidden");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== expected) {
    throw new HttpError(403, "Cross-site requests are forbidden");
  }
};
