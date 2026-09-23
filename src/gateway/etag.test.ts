import { describe, expect, test } from "bun:test";

import { jsonWithEtag } from "./etag";

const get = (headers: Record<string, string> = {}) =>
  new Request("http://gateway.test/proxy/v1/models", { headers });

describe("jsonWithEtag", () => {
  test("sends a stable strong ETag with the JSON body", async () => {
    const first = jsonWithEtag(get(), { data: [1] });
    const second = jsonWithEtag(get(), { data: [1] });
    expect(first.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(first.headers.get("content-type")).toBe("application/json");
    expect(await first.json()).toEqual({ data: [1] });
  });

  test("answers 304 when If-None-Match names the tag, weak or in a list", () => {
    const etag = jsonWithEtag(get(), { data: [1] }).headers.get("etag")!;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const response = jsonWithEtag(get({ "if-none-match": header }), { data: [1] });
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
    }
  });

  test("sends the body when the listing changed", () => {
    const stale = jsonWithEtag(get(), { data: [1] }).headers.get("etag")!;
    expect(jsonWithEtag(get({ "if-none-match": stale }), { data: [2] }).status).toBe(200);
  });
});
