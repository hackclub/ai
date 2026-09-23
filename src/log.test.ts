import { describe, expect, test } from "bun:test";
import pino from "pino";

import { loggerOptions } from "./log";

/** The production logger's options, writing to an array instead of stdout. */
const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(loggerOptions, {
    write: (line: string) => {
      lines.push(JSON.parse(line));
    },
  });
  return { logger, lines };
};

describe("log", () => {
  test("writes one JSON record with an ISO time, a named level, msg and fields", () => {
    const { logger, lines } = capture();
    logger.info({ a: 1 }, "x");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "x", a: 1 });
    expect(Number.isNaN(new Date(lines[0]!.time as string).getTime())).toBe(false);
  });

  test("keeps an error's cause and extra fields such as a Postgres code", () => {
    const { logger, lines } = capture();
    const err = Object.assign(new Error("insert failed", { cause: new Error("root") }), {
      code: "23505",
    });
    logger.error({ err }, "db");
    const logged = lines[0]!.err as { message: string; stack: string; code: string };
    expect(logged.code).toBe("23505");
    expect(logged.stack).toContain("caused by: Error: root");
  });

  test("never throws on values JSON.stringify rejects", () => {
    const { logger, lines } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logger.info({ amount: 1n, cyclic }, "odd")).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  test("redacts credential-bearing fields", () => {
    const { logger, lines } = capture();
    logger.info(
      { headers: { authorization: "Bearer sk-hc-v1-x", "x-api-key": "k", cookie: "s=1" }, input: { apiKey: "k" } },
      "request",
    );
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain("sk-hc-v1-x");
    expect(text).not.toContain('"k"');
    expect(text).not.toContain("s=1");
  });
});
