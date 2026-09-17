/**
 * An error whose message is safe to return to the API caller. The response
 * shape `{ "error": "<message>" }` matches the previous gateway so existing
 * clients keep working.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  toResponse(): Response {
    return Response.json({ error: this.message }, { status: this.status });
  }
}
