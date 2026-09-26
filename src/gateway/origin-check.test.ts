import { expect, test } from "bun:test";

import { assertSameOrigin } from "./origin-check";

const BASE_URL = "http://localhost:3000";

const check = (method: string, headers: Record<string, string>, baseUrl = BASE_URL) => () =>
  assertSameOrigin(new Request("http://gateway.test/api/keys", { method, headers }), baseUrl);

test.each([
  ["GET with a foreign origin", check("GET", { origin: "https://evil.example" })],
  ["POST with sec-fetch-site same-origin", check("POST", { "sec-fetch-site": "same-origin" })],
  ["POST with neither header (non-browser client)", check("POST", {})],
  ["POST when baseUrl has a trailing path", check("POST", { origin: BASE_URL }, `${BASE_URL}/`)],
])("allows %s", (_, run) => {
  expect(run).not.toThrow();
});
