/**
 * Preloaded by `bun test` (see bunfig.toml). `src/env.ts` validates the whole
 * environment at import time and exits the process if anything is missing, so
 * any test that imports a route needs these placeholders in place first. Only
 * unset variables are filled in, so a real .env still wins locally.
 */
const TEST_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://localhost:5432/test",
  BASE_URL: "https://ai.hackclub.com",
  PORT: "54321",
  HACK_CLUB_CLIENT_ID: "test-client-id",
  HACK_CLUB_CLIENT_SECRET: "test-client-secret",
  SLACK_GEOBLOCK_WEBHOOK_URL: "https://hooks.slack.com/services/test",
  OPENAI_API_URL: "https://openrouter.ai/api",
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_MODERATION_API_KEY: "test-moderation-key",
  OPENAI_MODERATION_API_URL: "https://api.openai.com/v1/moderations",
  ALLOWED_LANGUAGE_MODELS: "qwen/qwen3-32b,openai/gpt-5-mini",
  ALLOWED_IMAGE_MODELS: "google/gemini-2.5-flash-image",
  ALLOWED_EMBEDDING_MODELS: "qwen/qwen3-embedding-8b",
  NODE_ENV: "test",
  OPENROUTER_PROVISIONING_KEY: "test-provisioning-key",
  REPLICATE_SESSION_ID: "test-session-id",
  REPLICATE_API_KEY: "test-replicate-key",
  REPLICATE_USERNAME: "test-user",
  POSTHOG_API_KEY: "test-posthog-key",
  MISTRAL_API_KEY: "test-mistral-key",
  EXA_API_KEY: "test-exa-key",
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] ??= value;
}
