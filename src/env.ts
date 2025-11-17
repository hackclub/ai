import { type } from "arktype";

const envSchema = type({
  DATABASE_URL: "string",
  BASE_URL: "string",
  PORT: "string.numeric.parse",
  SLACK_CLIENT_ID: "string",
  SLACK_CLIENT_SECRET: "string",
  SLACK_TEAM_ID: "string",
  OPENAI_API_URL: "string",
  OPENAI_API_KEY: "string",
  ALLOWED_LANGUAGE_MODELS: "string",
  ALLOWED_EMBEDDING_MODELS: "string",
  "NODE_ENV?": "'development' | 'production' | 'test'",
  "ENFORCE_IDV?": type("'true' | 'false'").pipe((val) => val === "true"),
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
export const allowedEmbeddingModels = parseModelList(
  env.ALLOWED_EMBEDDING_MODELS,
);

export function getAllowedLanguageModels(): string[] {
  return allowedLanguageModels;
}

export function getAllowedEmbeddingModels(): string[] {
  return allowedEmbeddingModels;
}
