/**
 * An error whose message is safe to return to the API caller, serialised as
 * `{ "error": "<message>" }`. `headers` carry machine-readable hints such as
 * `Retry-After`; like the message, they must never hold secrets.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }

  toResponse(): Response {
    return Response.json({ error: this.message }, { status: this.status, headers: this.headers });
  }
}
