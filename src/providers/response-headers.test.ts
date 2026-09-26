import { describe, expect, test } from "bun:test";

import { forwardableHeaders } from "./response-headers";

describe("forwardableHeaders", () => {
  test("keeps payload and rate-limit headers, drops everything else", () => {
    const out = forwardableHeaders(
      new Headers({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-ratelimit-remaining": "9",
        "retry-after": "1",
        "content-length": "12",
        "content-encoding": "br",
        "transfer-encoding": "chunked",
        "set-cookie": "a=b",
        "access-control-allow-origin": "*",
        "strict-transport-security": "max-age=1",
        "x-upstream-internal": "secret",
      }),
    );
    expect([...out.keys()].sort()).toEqual(["cache-control", "content-type", "retry-after", "x-ratelimit-remaining"]);
  });
});
