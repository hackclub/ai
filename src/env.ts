import { type } from 'arktype';

const envSchema = type({
  DATABASE_URL: 'string',
  BASE_URL: 'string',
  PORT: 'string',
  SLACK_CLIENT_ID: 'string',
  SLACK_CLIENT_SECRET: 'string',
  SLACK_TEAM_ID: 'string',
  OPENAI_API_URL: 'string',
  OPENAI_API_KEY: 'string',
  'ALLOWED_MODELS?': 'string',
  'ALLOWED_LANGUAGE_MODELS?': 'string',
  'ALLOWED_EMBEDDING_MODELS?': 'string',
  'NODE_ENV?': "'development' | 'production' | 'test'",
});

const result = envSchema(process.env);

if (result instanceof type.errors) {
  console.error('Environment validation failed:');
  console.error(result.summary);
  process.exit(1);
}

export const env = result;

let cachedAllowedModels: string[] | null | undefined;
let cachedAllowedLanguageModels: string[] | null | undefined;
let cachedAllowedEmbeddingModels: string[] | null | undefined;

export function getAllowedModels(): string[] | null {
  if (cachedAllowedModels !== undefined) {
    return cachedAllowedModels;
  }
  if (!env.ALLOWED_MODELS || env.ALLOWED_MODELS.trim() === '') {
    cachedAllowedModels = null;
    return null;
  }
  cachedAllowedModels = env.ALLOWED_MODELS.split(',').map(m => m.trim()).filter(m => m.length > 0);
  return cachedAllowedModels;
}

export function getAllowedLanguageModels(): string[] | null {
  if (cachedAllowedLanguageModels !== undefined) {
    return cachedAllowedLanguageModels;
  }
  if (!env.ALLOWED_LANGUAGE_MODELS || env.ALLOWED_LANGUAGE_MODELS.trim() === '') {
    cachedAllowedLanguageModels = null;
    return null;
  }
  cachedAllowedLanguageModels = env.ALLOWED_LANGUAGE_MODELS.split(',').map(m => m.trim()).filter(m => m.length > 0);
  return cachedAllowedLanguageModels;
}

export function getAllowedEmbeddingModels(): string[] | null {
  if (cachedAllowedEmbeddingModels !== undefined) {
    return cachedAllowedEmbeddingModels;
  }
  if (!env.ALLOWED_EMBEDDING_MODELS || env.ALLOWED_EMBEDDING_MODELS.trim() === '') {
    cachedAllowedEmbeddingModels = null;
    return null;
  }
  cachedAllowedEmbeddingModels = env.ALLOWED_EMBEDDING_MODELS.split(',').map(m => m.trim()).filter(m => m.length > 0);
  return cachedAllowedEmbeddingModels;
}
