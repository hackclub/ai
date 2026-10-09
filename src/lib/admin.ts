import { invalidateAll } from "$app/navigation";

/**
 * Calls the admin API and reloads the page's data on success. Resolves to
 * the error message to show, or null.
 */
export async function adminRequest(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<string | null> {
  const response = await fetch(`/api/admin${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!response) return "Could not reach the server.";
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return payload.error ?? `Request failed (HTTP ${response.status}).`;
  }
  await invalidateAll();
  return null;
}
