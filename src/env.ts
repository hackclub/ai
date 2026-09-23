/**
 * Validated process configuration. Bun loads `.env` automatically; this
 * module only checks shape and applies defaults so a misconfigured deploy
 * fails at startup rather than on the first request.
 */
export type Env = {
  nodeEnv: "development" | "production" | "test";
  port: number;
  baseUrl: string;
  databaseUrl: string;
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  /** Models shown on the landing page and in quickstart snippets. */
  featuredModels: string[];
  enforceIdv: boolean;
  hackClubClientId: string;
  hackClubClientSecret: string;
  /** Sentry error reporting; disabled when unset. */
  sentryDsn: string | null;
  openAiModerationApiUrl: string;
  openAiModerationApiKey: string;
  mistralApiKey: string;
  /** Mistral OCR price per page in USD; Mistral reports no cost itself. */
  mistralOcrPagePriceUsd: string;
  /** Mistral OCR price per page when annotations are requested. */
  mistralOcrAnnotationPagePriceUsd: string;
  exaApiKey: string;
  replicateApiKey: string;
  /**
   * Browser session used by GET /up to read Replicate's unused credit. Not a
   * provider credential, so optional: /up skips the credit check without it.
   */
  replicateUsername: string | null;
  replicateSessionId: string | null;
  typesafeApiKey: string;
  /** Jev price per million input tokens in USD; TypeSafe reports no cost. Output is free. */
  typesafeInputPricePerMillionUsd: string;
  allowedImageModels: string[];
  /**
   * Output tokens reserved when a model exposes no maximum completion length
   * and the caller set no limit. Documented overage risk; see
   * docs/architecture/storage-and-billing.md.
   */
  reservationFallbackOutputTokens: number;
  /** Largest accepted HTTP request body, in bytes. */
  maxRequestBodyBytes: number;
};

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const required = (source: Record<string, string | undefined>, name: string) => {
  const value = source[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const integer = (
  source: Record<string, string | undefined>,
  name: string,
  fallback: number,
) => {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
};

export const loadEnv = (
  source: Record<string, string | undefined> = process.env,
): Env => {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (
    nodeEnv !== "development" &&
    nodeEnv !== "production" &&
    nodeEnv !== "test"
  ) {
    throw new Error("NODE_ENV must be development, production, or test");
  }

  const requiredInProduction = (name: string, fallback: string) =>
    nodeEnv === "production" ? required(source, name) : (source[name] || fallback);

  return {
    nodeEnv,
    port: integer(source, "PORT", 3000),
    baseUrl: source.BASE_URL ?? "http://localhost:3000",
    databaseUrl: required(source, "DATABASE_URL"),
    clickhouseUrl: requiredInProduction("CLICKHOUSE_URL", "http://localhost:8123"),
    clickhouseUser: requiredInProduction("CLICKHOUSE_USER", "hcai"),
    clickhousePassword: requiredInProduction("CLICKHOUSE_PASSWORD", "hcai"),
    openRouterApiKey: required(source, "OPENROUTER_API_KEY"),
    openRouterBaseUrl: source.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
    featuredModels: list(source.FEATURED_MODELS),
    enforceIdv: source.ENFORCE_IDV === "true",
    hackClubClientId: required(source, "HACK_CLUB_CLIENT_ID"),
    hackClubClientSecret: required(source, "HACK_CLUB_CLIENT_SECRET"),
    sentryDsn: source.SENTRY_DSN || null,
    openAiModerationApiUrl:
      source.OPENAI_MODERATION_API_URL || "https://api.openai.com/v1/moderations",
    openAiModerationApiKey: required(source, "OPENAI_MODERATION_API_KEY"),
    mistralApiKey: required(source, "MISTRAL_API_KEY"),
    mistralOcrPagePriceUsd: source.MISTRAL_OCR_PAGE_PRICE_USD || "0.001",
    mistralOcrAnnotationPagePriceUsd: source.MISTRAL_OCR_ANNOTATION_PAGE_PRICE_USD || "0.003",
    exaApiKey: required(source, "EXA_API_KEY"),
    replicateApiKey: required(source, "REPLICATE_API_KEY"),
    replicateUsername: source.REPLICATE_USERNAME || null,
    replicateSessionId: source.REPLICATE_SESSION_ID || null,
    typesafeApiKey: required(source, "TYPESAFE_API_KEY"),
    typesafeInputPricePerMillionUsd: source.TYPESAFE_INPUT_PRICE_PER_MILLION_USD || "0.042",
    allowedImageModels: list(source.ALLOWED_IMAGE_MODELS),
    reservationFallbackOutputTokens: integer(
      source,
      "RESERVATION_FALLBACK_OUTPUT_TOKENS",
      8192,
    ),
    maxRequestBodyBytes: integer(source, "MAX_REQUEST_BODY_BYTES", 20 * 1024 * 1024),
  };
};

/**
 * SvelteKit 3 reserves `src/env.ts` as its environment-schema module and
 * requires this export. The gateway validates its own configuration with
 * loadEnv above, so the schema stays empty.
 */
export const variables = {};
