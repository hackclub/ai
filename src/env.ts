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
  allowedLanguageModels: string[];
  allowedEmbeddingModels: string[];
  enforceIdv: boolean;
  /** Hack Club OAuth; sign-in routes are disabled when either is missing. */
  hackClubClientId: string | null;
  hackClubClientSecret: string | null;
  /** Slack incoming webhook notified when a flagged-country address signs in. */
  slackGeoblockWebhookUrl: string | null;
  posthogApiKey: string | null;
  posthogApiHost: string;
  posthogUiHost: string;
  /** Feature flags forced on without PostHog, e.g. enable_exa. */
  featureFlagsAlwaysEnabled: string[];
  /** Shared secret for POST /internal/revoke. */
  internalRevokeKey: string | null;
  openAiModerationApiUrl: string;
  openAiModerationApiKey: string | null;
  mistralApiKey: string | null;
  /** Mistral OCR price per page in USD; Mistral reports no cost itself. */
  mistralOcrPagePriceUsd: string;
  exaApiKey: string | null;
  replicateApiKey: string | null;
  allowedImageModels: string[];
  /**
   * Output tokens reserved when a model exposes no maximum completion length
   * and the caller set no limit. Documented overage risk; see
   * docs/architecture/storage-and-billing.md.
   */
  reservationFallbackOutputTokens: number;
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

  return {
    nodeEnv,
    port: integer(source, "PORT", 3000),
    baseUrl: source.BASE_URL ?? "http://localhost:3000",
    databaseUrl: required(source, "DATABASE_URL"),
    clickhouseUrl: source.CLICKHOUSE_URL ?? "http://localhost:8123",
    clickhouseUser: source.CLICKHOUSE_USER ?? "hcai",
    clickhousePassword: source.CLICKHOUSE_PASSWORD ?? "hcai",
    openRouterApiKey: required(source, "OPENROUTER_API_KEY"),
    openRouterBaseUrl: source.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
    allowedLanguageModels: list(source.ALLOWED_LANGUAGE_MODELS),
    allowedEmbeddingModels: list(source.ALLOWED_EMBEDDING_MODELS),
    enforceIdv: source.ENFORCE_IDV === "true",
    hackClubClientId: source.HACK_CLUB_CLIENT_ID || null,
    hackClubClientSecret: source.HACK_CLUB_CLIENT_SECRET || null,
    slackGeoblockWebhookUrl: source.SLACK_GEOBLOCK_WEBHOOK_URL || null,
    posthogApiKey: source.POSTHOG_API_KEY || null,
    posthogApiHost: source.POSTHOG_API_HOST || "https://us.i.posthog.com",
    posthogUiHost: source.POSTHOG_UI_HOST || "https://us.posthog.com",
    featureFlagsAlwaysEnabled: list(source.FEATURE_FLAGS_ALWAYS_ENABLED),
    internalRevokeKey: source.HCAI_REVOKER_KEY || null,
    openAiModerationApiUrl:
      source.OPENAI_MODERATION_API_URL || "https://api.openai.com/v1/moderations",
    openAiModerationApiKey: source.OPENAI_MODERATION_API_KEY || null,
    mistralApiKey: source.MISTRAL_API_KEY || null,
    mistralOcrPagePriceUsd: source.MISTRAL_OCR_PAGE_PRICE_USD || "0.001",
    exaApiKey: source.EXA_API_KEY || null,
    replicateApiKey: source.REPLICATE_API_KEY || null,
    allowedImageModels: list(source.ALLOWED_IMAGE_MODELS),
    reservationFallbackOutputTokens: integer(
      source,
      "RESERVATION_FALLBACK_OUTPUT_TOKENS",
      8192,
    ),
  };
};

/**
 * SvelteKit 3 reserves `src/env.ts` as its environment-schema module and
 * requires this export. The gateway validates its own configuration with
 * loadEnv above, so the schema stays empty.
 */
export const variables = {};
