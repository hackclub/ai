import { expect, test } from "bun:test";

import { cookieValue } from "./sessions";

test.each([
  ["a=1; session_token=abc%3D%3D; b=2", "abc=="],
  ["a=1", undefined],
  [null, undefined],
  // Not valid percent-encoding: a sibling host's cookie must not 500 every page.
  ["session_token=%E0", undefined],
  ["session_token=%", undefined],
  // Two cookies with one name means one was planted from the parent domain.
  ["session_token=a; session_token=b", undefined],
])("cookieValue(%p) is %p", (header, expected) => {
  expect(cookieValue(header, "session_token")).toBe(expected);
});
