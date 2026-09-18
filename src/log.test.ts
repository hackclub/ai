import { describe, expect, spyOn, test } from "bun:test";

import { log } from "./log";

describe("log", () => {
  test("info emits a JSON record with time, level, msg, and fields", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      log.info("x", { a: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      const record = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(record.level).toBe("info");
      expect(record.msg).toBe("x");
      expect(record.a).toBe(1);
      expect(Number.isNaN(new Date(record.time).getTime())).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("error serializes an Error field to name, message, and stack", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      log.error("y", { error: new Error("boom") });
      expect(spy).toHaveBeenCalledTimes(1);
      const record = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(record.level).toBe("error");
      expect(record.msg).toBe("y");
      expect(record.error.message).toBe("boom");
      expect(typeof record.error.stack).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });
});
