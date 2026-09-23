import { expect, test } from "bun:test";

import { blockedPrompts } from "../../config/blocked-prompts";
import { BLOCKED_MESSAGE } from "../abuse";
import { moderationRoutes } from "./moderations";
import { testDatabase } from "../../test/database";
import { createTestAccount, fakeFetch, post } from "./test-harness";

const { sql } = await testDatabase();
const { apiKey } = await createTestAccount(sql, "moderations");
const authorized = { authorization: `Bearer ${apiKey}` };

const build = (respond: () => Response) => {
  const { fetch, upstream } = fakeFetch(respond);
  const app = moderationRoutes({
    sql,
    enforceIdv: false,
    moderationApiUrl: "https://mod.test/v1/moderations",
    moderationApiKey: "mk",
    fetch,
  });
  return { app, upstream };
};

test("forwards the body with the configured key and mirrors the upstream response", async () => {
  const { app, upstream } = build(
    () =>
      new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  );
  const response = await app.handle(post("/proxy/v1/moderations", { input: "hi" }, authorized));
  expect(upstream).toHaveLength(1);
  expect(upstream[0]?.headers.get("authorization")).toBe("Bearer mk");
  expect(upstream[0]?.body).toBe(JSON.stringify({ input: "hi" }));
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(await response.json()).toEqual({ error: "bad request" });
});

test("blocks a known agent system prompt before reaching upstream", async () => {
  const { app, upstream } = build(() => Response.json({ results: [] }));
  const response = await app.handle(post("/proxy/v1/moderations", { input: blockedPrompts[0] }, authorized));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
  expect(upstream).toEqual([]);
});
