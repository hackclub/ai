import { describe, expect, test } from "bun:test";

import { loadEnv } from "./env";

const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
  "HACK_CLUB_CLIENT_ID",
  "HACK_CLUB_CLIENT_SECRET",
  "OPENAI_MODERATION_API_KEY",
  "MISTRAL_API_KEY",
  "EXA_API_KEY",
  "REPLICATE_API_KEY",
] as const;

const base = {
  DATABASE_URL: "postgres://x",
  ...Object.fromEntries(PROVIDER_KEYS.map((name) => [name, "set"])),
};

describe("loadEnv provider credentials", () => {
  for (const name of PROVIDER_KEYS) {
    test(`refuses to start without ${name}`, () => {
      expect(() => loadEnv({ ...base, [name]: "" })).toThrow(
        `Missing required environment variable ${name}`,
      );
    });
  }

  test("leaves the Replicate browser session optional", () => {
    const env = loadEnv(base);
    expect(env.replicateUsername).toBeNull();
    expect(env.replicateSessionId).toBeNull();
  });
});

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
