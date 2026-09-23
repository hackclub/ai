import type { Fetch } from "../../providers/openrouter/adapter";
import { Elysia } from "elysia";
import type postgres from "postgres";

import type { RateLimiter } from "../rate-limit";
import { authorizeProviderRequest, defaultRateLimiter, parseJsonObject } from "./shared";

export type ModerationRouteDependencies = {
  sql: postgres.Sql;
  enforceIdv: boolean;
  moderationApiUrl: string;
  moderationApiKey: string;
  rateLimiter?: RateLimiter;
  fetch?: Fetch;
};

/**
 * `POST /proxy/v1/moderations`: OpenAI's free moderation endpoint through the
 * shared account. Not billed and not logged, as before.
 */
export const moderationRoutes = (deps: ModerationRouteDependencies) => {
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter();
  const fetchImplementation = deps.fetch ?? fetch;

  return new Elysia({ prefix: "/proxy/v1" }).post("/moderations", async ({ request }) => {
    const rawBody = await request.text();
    await authorizeProviderRequest(deps, rateLimiter, request, rawBody);
    const body = parseJsonObject(rawBody);

    const upstream = await fetchImplementation(deps.moderationApiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.moderationApiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  });
};
