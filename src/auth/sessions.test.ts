import { describe, expect, test } from "bun:test";

import { cookieValue } from "./sessions";

describe("cookieValue", () => {
  test("decodes the named cookie and ignores the rest", () => {
    expect(cookieValue("a=1; session_token=abc%3D%3D; b=2", "session_token")).toBe("abc==");
    expect(cookieValue("a=1", "session_token")).toBeUndefined();
    expect(cookieValue(null, "session_token")).toBeUndefined();
  });

  test("treats a value that is not valid percent-encoding as no cookie", () => {
    // A browser may carry a cookie set by a sibling host; it must not 500 every page.
    expect(cookieValue("session_token=%E0", "session_token")).toBeUndefined();
    expect(cookieValue("session_token=%", "session_token")).toBeUndefined();
  });
});
