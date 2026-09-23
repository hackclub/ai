import { describe, expect, test } from "bun:test";

import { isApiPath, isCrossOriginFormSubmission } from "./hooks.paths";

describe("isApiPath", () => {
  test.each(["/up", "/proxy", "/proxy/v1/models", "/api/keys", "/auth/login", "/internal/revoke"])(
    "%s is served by Elysia",
    (pathname) => {
      expect(isApiPath(pathname)).toBeTrue();
    },
  );

  test.each(["/dashboard", "/proxying", "/apix", "/"])("%s is a page route", (pathname) => {
    expect(isApiPath(pathname)).toBeFalse();
  });
});

describe("isCrossOriginFormSubmission", () => {
  const origin = "https://gw.test";
  const evil = "https://evil.test";
  const form = "application/x-www-form-urlencoded";

  test.each([
    ["POST", form, evil, true],
    ["POST", form, origin, false],
    ["GET", form, evil, false],
    ["POST", "application/json", evil, false],
    ["POST", "multipart/form-data; boundary=x", evil, true],
    ["POST", "text/plain", evil, true],
  ])("%s %s from %s -> %p", (method, contentType, from, expected) => {
    const request = new Request("https://gw.test/dashboard", {
      method,
      headers: { "content-type": contentType, origin: from },
    });
    expect(isCrossOriginFormSubmission(request, origin)).toBe(expected);
  });
});
