import { webcrypto } from "node:crypto";
import path from "node:path";
import { vi } from "vitest";

const envDefaults: Record<string, string> = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  BASE_URL: "https://example.test",
  PORT: "3000",
  HACK_CLUB_CLIENT_ID: "hc-client-id",
  HACK_CLUB_CLIENT_SECRET: "hc-client-secret",
  OPENAI_API_URL: "https://api.openai.test",
  OPENAI_API_KEY: "sk-test",
  OPENAI_MODERATION_API_KEY: "sk-test-moderation",
  OPENAI_MODERATION_API_URL: "https://api.openai.test/moderations",
  ALLOWED_LANGUAGE_MODELS: "gpt-4o-mini",
  ALLOWED_IMAGE_MODELS: "gpt-image-1",
  ALLOWED_EMBEDDING_MODELS: "text-embedding-3-small",
  NODE_ENV: "test",
  OPENROUTER_PROVISIONING_KEY: "openrouter-provisioning-key",
  REPLICATE_SESSION_ID: "replicate-session-id",
  REPLICATE_API_KEY: "replicate-api-key",
  REPLICATE_USERNAME: "replicate-username",
  POSTHOG_API_KEY: "posthog-api-key",
  POSTHOG_UI_HOST: "https://us.posthog.com",
  POSTHOG_API_HOST: "https://us.i.posthog.com/",
  MISTRAL_API_KEY: "mistral-api-key",
};

for (const [key, value] of Object.entries(envDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto;
}

vi.doMock("@sentry/bun", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  startSpan: (_opts: unknown, fn: unknown) =>
    typeof fn === "function" ? (fn as () => unknown)() : fn,
  setUser: vi.fn(),
}));

vi.doMock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const readFileSync: typeof actual.readFileSync = (pathLike, ...args) => {
    const filePath =
      typeof pathLike === "string" ? pathLike : pathLike.toString();
    if (filePath.endsWith("allowed-replicate-model-versions.json")) {
      return "{}";
    }
    return actual.readFileSync(pathLike, ...args);
  };

  return {
    ...actual,
    default: actual,
    readFileSync,
  };
});

vi.doMock("postgres", () => ({
  default: () => ({
    end: vi.fn(),
  }),
}));

vi.doMock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.doMock("drizzle-orm/postgres-js/migrator", () => ({
  migrate: vi.fn(async () => undefined),
}));

vi.doMock("posthog-node", () => ({
  PostHog: class {
    identify = vi.fn();
    capture = vi.fn();
    isFeatureEnabled = vi.fn(async () => false);
  },
}));

vi.doMock("bun", () => ({
  dns: { prefetch: vi.fn() },
}));

vi.doMock("hono/bun", () => ({
  serveStatic: () => async (_c: unknown, next?: () => Promise<void>) =>
    next?.(),
}));

const rootDir = path.resolve(__dirname, "..");
const migratePath = path.resolve(rootDir, "src", "migrate.ts");

vi.doMock(migratePath, () => ({
  runMigrations: vi.fn(async () => undefined),
}));
