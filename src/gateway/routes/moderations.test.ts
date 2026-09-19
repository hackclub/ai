import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type postgres from "postgres";

import { blockedPrompts } from "../../config/blocked-prompts";
import type { Fetch } from "../../providers/openrouter/adapter";
import { BLOCKED_MESSAGE } from "../abuse";
import { HttpError } from "../http-error";
import { moderationRoutes } from "./moderations";

/** Answers the api-key lookup every authenticated route issues. */
const fakeSql = () =>
  (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM api_keys")) {
      return [
        {
          api_key_id: "key-1",
          user_id: "user-1",
          billing_account_id: "account-1",
          billing_account_status: "active",
          is_banned: false,
          is_idv_verified: true,
          skip_idv: false,
        },
      ];
    }
    return [];
  }) as unknown as postgres.Sql;

const fakeFetch = (respond: () => Response) => {
  const upstream: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fetchImplementation: Fetch = async (input, init) => {
    upstream.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return respond();
  };
  return { fetch: fetchImplementation, upstream };
};

type Overrides = Partial<Parameters<typeof moderationRoutes>[0]>;

const build = (respond: () => Response, overrides: Overrides = {}) => {
  const { fetch, upstream } = fakeFetch(respond);
  const routes = moderationRoutes({
    sql: fakeSql(),
    enforceIdv: false,
    moderationApiUrl: "https://mod.test/v1/moderations",
    moderationApiKey: "mk",
    fetch,
    ...overrides,
  });
  // Mirrors the HttpError handling createApp installs in front of every route group.
  const app = new Elysia()
    .error(({ error }) =>
      error instanceof HttpError
        ? error.toResponse()
        : Response.json({ error: "Internal server error" }, { status: 500 }),
    )
    .use(routes);
  return { app, upstream };
};

const request = (body: unknown, init: RequestInit = {}) =>
  new Request("http://gateway.test/proxy/v1/moderations", {
    method: "POST",
    headers: { authorization: "Bearer sk-hc-v1-test", "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

describe("moderationRoutes", () => {
  test("503s when no moderation key is configured", async () => {
    const { app } = build(() => Response.json({ results: [] }), { moderationApiKey: "" });
    const response = await app.handle(request({ input: "hi" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Moderation is not configured" });
  });

  test("forwards a bearer token built from the configured key and the parsed body", async () => {
    const { app, upstream } = build(() => Response.json({ results: [] }));
    const body = { input: "hi" };
    await app.handle(request(body));
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.headers.get("authorization")).toBe("Bearer mk");
    expect(upstream[0]?.body).toBe(JSON.stringify(body));
  });

  test("mirrors a successful upstream status and content-type", async () => {
    const { app } = build(
      () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await app.handle(request({ input: "hi" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ results: [] });
  });

  test("mirrors a failing upstream status and content-type", async () => {
    const { app } = build(
      () =>
        new Response(JSON.stringify({ error: "bad request" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    );
    const response = await app.handle(request({ input: "hi" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ error: "bad request" });
  });

  test("blocks a known agent system prompt before reaching upstream", async () => {
    const { app, upstream } = build(() => Response.json({ results: [] }));
    const response = await app.handle(request({ input: blockedPrompts[0] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
    expect(upstream).toEqual([]);
  });
});
