import { describe, expect, test } from "bun:test";

import { isApiPath, isCrossOriginFormSubmission } from "./hooks.paths";

describe("isApiPath", () => {
  test.each([
    "/up",
    "/proxy",
    "/proxy/v1/models",
    "/api/keys",
    "/auth/login",
    "/internal/revoke",
  ])("%s is served by Elysia", (pathname) => {
    expect(isApiPath(pathname)).toBeTrue();
  });

  test.each(["/dashboard", "/proxying", "/apix", "/"])("%s is a page route", (pathname) => {
    expect(isApiPath(pathname)).toBeFalse();
  });
});

describe("isCrossOriginFormSubmission", () => {
  const origin = "https://gw.test";

  const request = (init: RequestInit) => new Request("https://gw.test/dashboard", init);

  test("POST + form content-type + foreign origin is cross-origin", () => {
    const req = request({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" },
    });
    expect(isCrossOriginFormSubmission(req, origin)).toBeTrue();
  });

  test("POST + form content-type + same origin is not cross-origin", () => {
    const req = request({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
    });
    expect(isCrossOriginFormSubmission(req, origin)).toBeFalse();
  });

  test("GET requests are never cross-origin form submissions", () => {
    const req = request({
      method: "GET",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" },
    });
    expect(isCrossOriginFormSubmission(req, origin)).toBeFalse();
  });

  test("application/json is not a form submission", () => {
    const req = request({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
    });
    expect(isCrossOriginFormSubmission(req, origin)).toBeFalse();
  });

  test("multipart/form-data with a boundary, foreign origin, is cross-origin", () => {
    const req = request({
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", origin: "https://evil.test" },
    });
    expect(isCrossOriginFormSubmission(req, origin)).toBeTrue();
  });

  test("text/plain, foreign origin, is cross-origin", () => {
    const req = request({
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.test" },
    });
    expect(isCrossOriginFormSubmission(req, origin)).toBeTrue();
  });
});
