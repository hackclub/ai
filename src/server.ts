import { type ClickHouseClient, createClient } from "@clickhouse/client";
import * as Sentry from "@sentry/bun";
import type { AnyElysia } from "elysia";
import postgres from "postgres";

import { AnalyticsQueries } from "./analytics/queries";
import { startAnalyticsWorker } from "./analytics/worker";
import { createApp } from "./app";
import { hackClubAuthRoutes } from "./auth/hackclub";
import { BillingEngine } from "./billing/engine";
import type { Env } from "./env";
import { createHealthCheck } from "./gateway/health";
import { keysApiRoutes } from "./gateway/keys-api";
import { SettlementTracker } from "./gateway/metered-request";
import { RateLimiter } from "./gateway/rate-limit";
import { exaRoutes } from "./gateway/routes/exa";
import { imagesRoutes } from "./gateway/routes/images";
import { jevRoutes } from "./gateway/routes/jev";
import { moderationRoutes } from "./gateway/routes/moderations";
import { ocrRoutes } from "./gateway/routes/ocr";
import { replicateRoutes } from "./gateway/routes/replicate";
import { webhookRoutes } from "./gateway/webhooks";
import { log } from "./log";
import { pendingPostgresMigrations } from "./migrations";
import { ModelCatalog } from "./models/catalog";
import { OpenRouterAdapter } from "./providers/openrouter/adapter";
import { createReplicateCatalog, type ReplicateCatalog } from "./providers/replicate/catalog";
import { createReplicatePricingSource } from "./providers/replicate/pricing";

// The orchestrator's termination grace period must exceed this so the
// process is not SIGKILLed mid-drain.
const SETTLEMENT_DRAIN_TIMEOUT_MS = 30_000;

export type Backend = {
  app: ReturnType<typeof createApp>;
  sql: postgres.Sql;
  clickhouse: ClickHouseClient;
  billing: BillingEngine;
  settlements: SettlementTracker;
  catalog: ModelCatalog;
  /** Replicate model listing for the dashboard; null when REPLICATE_API_KEY is unset. */
  replicateCatalog: ReplicateCatalog | null;
  queries: AnalyticsQueries;
  env: Env;
  /** Starts the job worker; idempotent. */
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  /** Set by the lifecycle when background services fail to start; read by /up. */
  startupError: () => Error | null;
  setStartupError: (error: Error | null) => void;
};

/**
 * Builds every backend service from the environment. Used by the standalone
 * API entrypoint and by the SvelteKit server hook, which embeds the same
 * Elysia app for non-page routes.
 */
export const createBackend = (env: Env): Backend => {
  const sql = postgres(env.databaseUrl, { max: 16 });
  const clickhouse = createClient({
    url: env.clickhouseUrl,
    username: env.clickhouseUser,
    password: env.clickhousePassword,
  });
  const settlements = new SettlementTracker();
  const billing = Object.assign(new BillingEngine(sql), { settlements });
  Sentry.init({
    dsn: env.sentryDsn ?? undefined,
    enabled: env.sentryDsn !== null,
    environment: env.nodeEnv,
    // Requests carry bearer API keys and session cookies; never ship those.
    sendDefaultPii: false,
    tracesSampleRate: env.nodeEnv === "production" ? 0.1 : 1.0,
  });
  const attributionHeaders = {
    "HTTP-Referer": `${env.baseUrl}/global?utm_source=openrouter`,
    "X-Title": "Hack Club AI",
  };
  const catalog = new ModelCatalog({
    baseUrl: env.openRouterBaseUrl,
    apiKey: env.openRouterApiKey,
    headers: attributionHeaders,
  });
  const queries = new AnalyticsQueries(clickhouse);
  const adapter = new OpenRouterAdapter({ baseUrl: env.openRouterBaseUrl });
  const openRouter = { apiKey: env.openRouterApiKey, baseUrl: env.openRouterBaseUrl };
  // One counter shared by every proxy route group, keyed by user.
  const rateLimiter = new RateLimiter({ limit: 7_500, windowMs: 30 * 60 * 1_000 });
  const onSettlementError = (error: unknown, requestId: string) => {
    log.error("billing settlement failed", { requestId, error });
    Sentry.captureException(error, { tags: { requestId, stage: "billing.settle" } });
  };
  const metered = { sql, billing, enforceIdv: env.enforceIdv, rateLimiter, onSettlementError };
  // One pricing cache shared by the route and the reconciler.
  const replicatePricing = env.replicateApiKey ? createReplicatePricingSource({}) : null;
  const replicateCatalog =
    env.replicateApiKey && replicatePricing
      ? createReplicateCatalog({ apiKey: env.replicateApiKey, pricing: replicatePricing })
      : null;

  const routes: AnyElysia[] = [
    exaRoutes({ ...metered, exaApiKey: env.exaApiKey }),
    ocrRoutes({
      ...metered,
      mistralApiKey: env.mistralApiKey,
      perPagePriceUsd: env.mistralOcrPagePriceUsd,
      annotationPagePriceUsd: env.mistralOcrAnnotationPagePriceUsd,
    }),
    jevRoutes({
      ...metered,
      typesafeApiKey: env.typesafeApiKey,
      inputPricePerMillionTokensUsd: env.typesafeInputPricePerMillionUsd,
    }),
    moderationRoutes({
      ...metered,
      moderationApiUrl: env.openAiModerationApiUrl,
      moderationApiKey: env.openAiModerationApiKey,
    }),
    imagesRoutes({
      ...metered,
      adapter,
      openRouterApiKey: env.openRouterApiKey,
      allowedImageModels: env.allowedImageModels,
      attributionHeaders,
    }),
    keysApiRoutes({ sql, baseUrl: env.baseUrl, secureCookies: env.nodeEnv === "production" }),
    webhookRoutes({ sql }),
  ];
  if (env.replicateApiKey && replicatePricing) {
    routes.push(
      replicateRoutes({
        ...metered,
        replicateApiKey: env.replicateApiKey,
        publicBaseUrl: env.baseUrl,
        pricing: replicatePricing,
        maxUploadBytes: env.maxRequestBodyBytes,
      }),
    );
  }
  if (env.hackClubClientId && env.hackClubClientSecret) {
    routes.push(
      hackClubAuthRoutes({
        sql,
        clientId: env.hackClubClientId,
        clientSecret: env.hackClubClientSecret,
        baseUrl: env.baseUrl,
        secureCookies: env.nodeEnv === "production",
      }),
    );
  }

  let startupError: Error | null = null;

  const app = createApp({
    onError: (error) => {
      log.error("unhandled request error", { error });
      Sentry.captureException(error);
    },
    health: createHealthCheck({
      sql,
      clickhouse,
      openRouter,
      replicate:
        env.replicateUsername && env.replicateSessionId
          ? { username: env.replicateUsername, sessionId: env.replicateSessionId }
          : null,
      mistral: env.mistralApiKey ? { apiKey: env.mistralApiKey } : null,
      exa: env.exaApiKey ? { apiKey: env.exaApiKey } : null,
      startupError: () => startupError,
    }),
    proxy: {
      sql,
      billing,
      catalog,
      adapter,
      openRouterApiKey: env.openRouterApiKey,
      enforceIdv: env.enforceIdv,
      reservationFallbackOutputTokens: env.reservationFallbackOutputTokens,
      attributionHeaders,
      rateLimiter,
      onSettlementError,
    },
    routes,
  });

  let worker: Awaited<ReturnType<typeof startAnalyticsWorker>> | null = null;
  return {
    app,
    sql,
    clickhouse,
    billing,
    settlements,
    catalog,
    replicateCatalog,
    queries,
    env,
    start: async () => {
      const pending = await pendingPostgresMigrations(sql);
      if (pending.length > 0) {
        log.error("pending PostgreSQL migrations", {
          count: pending.length,
          migrations: pending,
          hint: "Run: bun run db:migrate",
        });
      }
      // Also creates the job-queue schema, which finalization depends on.
      worker ??= await startAnalyticsWorker({
        connectionString: env.databaseUrl,
        clickhouse,
        reconciliation: {
          sql,
          billing,
          openRouter,
          replicate:
            env.replicateApiKey && replicatePricing
              ? { apiKey: env.replicateApiKey, pricing: replicatePricing }
              : undefined,
        },
        log: (message) => log.info("billing.reconcile", { message }),
      });
    },
    shutdown: async () => {
      await worker?.stop();
      const { remaining } = await settlements.drain(SETTLEMENT_DRAIN_TIMEOUT_MS);
      if (remaining > 0) {
        log.error("shutdown abandoned in-flight settlements", { remaining });
      }
      await Sentry.flush(2_000).catch(() => {});
      await sql.end();
      await clickhouse.close();
    },
    startupError: () => startupError,
    setStartupError: (error) => {
      startupError = error;
    },
  };
};
