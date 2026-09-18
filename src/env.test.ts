import { describe, expect, test } from "bun:test";

import { loadEnv } from "./env";

const base = {
  DATABASE_URL: "postgres://x",
  OPENROUTER_API_KEY: "k",
  TYPESAFE_API_KEY: "t",
};

describe("loadEnv ClickHouse credentials", () => {
  test("development falls back to the compose defaults", () => {
    const env = loadEnv({ ...base, NODE_ENV: "development" });
    expect(env.clickhouseUrl).toBe("http://localhost:8123");
    expect(env.clickhouseUser).toBe("hcai");
    expect(env.clickhousePassword).toBe("hcai");
  });

  test("production refuses to start without each ClickHouse variable", () => {
    const production = {
      ...base,
      NODE_ENV: "production",
      CLICKHOUSE_URL: "http://ch.internal:8123",
      CLICKHOUSE_USER: "gateway",
      CLICKHOUSE_PASSWORD: "set",
    };
    expect(() => loadEnv(production)).not.toThrow();
    for (const name of ["CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD"]) {
      expect(() => loadEnv({ ...production, [name]: "" })).toThrow(name);
      expect(() => loadEnv({ ...production, [name]: undefined })).toThrow(name);
    }
  });
});
