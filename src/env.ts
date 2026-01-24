import { type } from "arktype";

const envSchema = type({
  DATABASE_URL: "string",
  BASE_URL: "string",
  PORT: "string.numeric.parse",
  HACK_CLUB_CLIENT_ID: "string",
  HACK_CLUB_CLIENT_SECRET: "string",
  OPENAI_API_URL: "string",
  OPENAI_API_KEY: "string",
  OPENAI_MODERATION_API_KEY: "string",
  OPENAI_MODERATION_API_URL: "string",
  ALLOWED_LANGUAGE_MODELS: "string",
  ALLOWED_IMAGE_MODELS: "string",
  ALLOWED_EMBEDDING_MODELS: "string",
  NODE_ENV: "'development' | 'production' | 'test' = 'development'",
  "ENFORCE_IDV?": type("'true' | 'false'").pipe((val) => val === "true"),
  "SENTRY_DSN?": "string",
  "OPENROUTER_PROVISIONING_KEY?": "string",
  REPLICATE_API_KEY: "string",
  POSTHOG_API_KEY: "string",
  POSTHOG_HOST: "string",
  
});

const result = envSchema(process.env);

if (result instanceof type.errors) {
  console.error("Environment validation failed:");
  console.error(result.summary);
  process.exit(1);
}

export const env = result;

function parseModelList(value: string): string[] {
  return value
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

export const allowedLanguageModels = parseModelList(
  env.ALLOWED_LANGUAGE_MODELS,
);
export const allowedImageModels = parseModelList(env.ALLOWED_IMAGE_MODELS);
export const allowedEmbeddingModels = parseModelList(
  env.ALLOWED_EMBEDDING_MODELS,
);
