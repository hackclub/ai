import { describe, expect, test } from "bun:test";

import { bearerToken } from "./api-keys";

describe("API key material", () => {
  test("extracts bearer tokens case-insensitively", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer   abc ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});
