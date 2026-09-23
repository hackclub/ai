/**
 * Serialises `value` as JSON with a strong ETag over the body, answering 304
 * when the request's `If-None-Match` already names it. Matches the Hono
 * `etag()` middleware the previous gateway used on its model listings.
 */
export const jsonWithEtag = (request: Request, value: unknown): Response => {
  const body = JSON.stringify(value);
  const etag = `"${new Bun.CryptoHasher("sha1").update(body).digest("hex")}"`;
  const headers = { etag, "content-type": "application/json" };
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(body, { headers });
};

/** `If-None-Match` uses weak comparison (RFC 9110 §13.1.2). */
const matchesIfNoneMatch = (header: string | null, etag: string) => {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);
};
