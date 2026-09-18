/**
 * Headers an upstream provider response may carry back to the client. The
 * gateway shares an origin with the dashboard and its session cookie, so
 * everything else (set-cookie, access-control-*, security headers, hop-by-hop
 * connection headers) is dropped rather than forwarded.
 */
const ALLOWED_EXACT = new Set([
  "content-type",
  "content-disposition",
  "cache-control",
  "retry-after",
  "x-request-id",
  "content-length",
]);

const ALLOWED_PREFIXES = ["x-ratelimit-"];

export const forwardableHeaders = (
  upstream: Headers,
  options: { keepContentLength?: boolean } = {},
): Headers => {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    const key = name.toLowerCase();
    if (key === "content-length" && !options.keepContentLength) return;
    if (ALLOWED_EXACT.has(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      headers.append(key, value);
    }
  });
  return headers;
};
