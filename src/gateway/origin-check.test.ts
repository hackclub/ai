import { describe, expect, test } from "bun:test";

import { HttpError } from "./http-error";
import { assertSameOrigin } from "./origin-check";

const BASE_URL = "http://localhost:3000";

const request = (method: string, headers: Record<string, string>) =>
  new Request("http://gateway.test/api/keys", { method, headers });

describe("assertSameOrigin", () => {
  test("GET with a foreign origin does not throw", () => {
    expect(() => assertSameOrigin(request("GET", { origin: "https://evil.example" }), BASE_URL)).not.toThrow();
  });

  test("POST with a matching origin does not throw", () => {
    expect(() => assertSameOrigin(request("POST", { origin: BASE_URL }), BASE_URL)).not.toThrow();
  });

  test("POST with a foreign origin throws HttpError 403", () => {
    expect(() => assertSameOrigin(request("POST", { origin: "https://evil.example" }), BASE_URL)).toThrow(HttpError);
    try {
      assertSameOrigin(request("POST", { origin: "https://evil.example" }), BASE_URL);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(403);
    }
  });

  test("POST with sec-fetch-site cross-site and no origin throws 403", () => {
    try {
      assertSameOrigin(request("POST", { "sec-fetch-site": "cross-site" }), BASE_URL);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(403);
    }
  });

  test("POST with sec-fetch-site same-origin and no origin does not throw", () => {
    expect(() => assertSameOrigin(request("POST", { "sec-fetch-site": "same-origin" }), BASE_URL)).not.toThrow();
  });

  test("POST with neither header does not throw", () => {
    expect(() => assertSameOrigin(request("POST", {}), BASE_URL)).not.toThrow();
  });

  test("baseUrl with a path still compares origins only", () => {
    expect(() =>
      assertSameOrigin(request("POST", { origin: BASE_URL }), "http://localhost:3000/"),
    ).not.toThrow();
  });
});
