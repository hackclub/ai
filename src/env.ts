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

export function getAllowedModels(): string[] | null {
  if (!env.ALLOWED_MODELS || env.ALLOWED_MODELS.trim() === '') {
    return null;
  }
  return env.ALLOWED_MODELS.split(',').map(m => m.trim()).filter(m => m.length > 0);
}

export function getAllowedLanguageModels(): string[] | null {
  if (!env.ALLOWED_LANGUAGE_MODELS || env.ALLOWED_LANGUAGE_MODELS.trim() === '') {
    return null;
  }
  return env.ALLOWED_LANGUAGE_MODELS.split(',').map(m => m.trim()).filter(m => m.length > 0);
}

export function getAllowedEmbeddingModels(): string[] | null {
  if (!env.ALLOWED_EMBEDDING_MODELS || env.ALLOWED_EMBEDDING_MODELS.trim() === '') {
    return null;
  }
  return env.ALLOWED_EMBEDDING_MODELS.split(',').map(m => m.trim()).filter(m => m.length > 0);
}
