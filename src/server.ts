import { type ClickHouseClient, createClient } from "@clickhouse/client";
import * as Sentry from "@sentry/bun";
import type { AnyElysia } from "elysia";
import postgres from "postgres";

import { AnalyticsQueries } from "./analytics/queries";
import { startAnalyticsWorker } from "./analytics/worker";
import { createApp } from "./app";
import { hackClubAuthRoutes } from "./auth/hackclub";
import { createSessions, type Sessions } from "./auth/sessions";
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

const SETTLEMENT_DRAIN_TIMEOUT_MS = 30_000;

export type Backend = {
  app: ReturnType<typeof createApp>;
  /** Resolves the dashboard's session cookie; hooks.server.ts calls it per page request. */
  sessions: Sessions;
  sql: postgres.Sql;
  clickhouse: ClickHouseClient;
  billing: BillingEngine;
  settlements: SettlementTracker;
  catalog: ModelCatalog;
  replicateCatalog: ReplicateCatalog;
  queries: AnalyticsQueries;
  env: Env;
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
};

export const createBackend = (env: Env): Backend => {
  const sql = postgres(env.databaseUrl, { max: 16 });
  const clickhouse = createClient({
    url: env.clickhouseUrl,
    username: env.clickhouseUser,
    password: env.clickhousePassword,
    database: env.clickhouseDatabase,
  });
  const settlements = new SettlementTracker();
  const billing = new BillingEngine(sql);
  // Unchanged derivation (plans/README: the maintainer keeps Secure tied to NODE_ENV).
  const secureCookies = env.nodeEnv === "production";
  const sessions = createSessions({ sql, secureCookies });
  Sentry.init({
    dsn: env.sentryDsn ?? undefined,
    enabled: env.sentryDsn !== null,
    environment: env.nodeEnv,
    // Requests carry bearer API keys and session cookies; never ship those.
    sendDefaultPii: false,
    tracesSampleRate: env.nodeEnv === "production" ? 0.1 : 1.0,
  });
  const attributionHeaders = {
    "HTTP-Referer": env.baseUrl,
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
    log.error({ err: error, requestId }, "billing settlement failed");
    Sentry.captureException(error, { tags: { requestId, stage: "billing.settle" } });
  };
  const metered = { sql, billing, settlements, enforceIdv: env.enforceIdv, rateLimiter, onSettlementError };
  // One pricing cache shared by the route and the reconciler.
  const replicatePricing = createReplicatePricingSource({});
  const replicateCatalog = createReplicateCatalog({
    apiKey: env.replicateApiKey,
    pricing: replicatePricing,
  });

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
    keysApiRoutes({ sql, baseUrl: env.baseUrl, sessions }),
    webhookRoutes({ sql }),
    replicateRoutes({
      ...metered,
      replicateApiKey: env.replicateApiKey,
      publicBaseUrl: env.baseUrl,
      pricing: replicatePricing,
      maxUploadBytes: env.maxRequestBodyBytes,
    }),
    hackClubAuthRoutes({
      sql,
      clientId: env.hackClubClientId,
      clientSecret: env.hackClubClientSecret,
      baseUrl: env.baseUrl,
      secureCookies,
      sessions,
    }),
  ];

  const app = createApp({
    onError: (error) => {
      log.error({ err: error }, "unhandled request error");
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
      mistral: { apiKey: env.mistralApiKey },
      exa: { apiKey: env.exaApiKey },
    }),
    proxy: {
      sql,
      billing,
      settlements,
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
  const startServices = async () => {
    const pending = await pendingPostgresMigrations(sql);
    if (pending.length > 0) {
      throw new Error(
        `${pending.length} pending PostgreSQL migrations (${pending.join(", ")}); run bun run db:migrate`,
      );
    }
    // Also creates the job-queue schema, which finalization depends on.
    worker ??= await startAnalyticsWorker({
      connectionString: env.databaseUrl,
      clickhouse,
      reconciliation: {
        sql,
        billing,
        openRouter,
        replicate: { apiKey: env.replicateApiKey, pricing: replicatePricing },
      },
      log: (message) => log.info({ message }, "billing.reconcile"),
    });
  };
  return {
    app,
    sessions,
    sql,
    clickhouse,
    billing,
    settlements,
    catalog,
    replicateCatalog,
    queries,
    env,
    start: async () => {
      try {
        await startServices();
      } catch (error) {
        log.error({ err: error }, "backend start failed");
        Sentry.captureException(error, { tags: { stage: "startup" } });
        throw error;
      }
    },
    shutdown: async () => {
      await worker?.stop();
      const { remaining } = await settlements.drain(SETTLEMENT_DRAIN_TIMEOUT_MS);
      if (remaining > 0) {
        log.error({ remaining }, "shutdown abandoned in-flight settlements");
      }
      await Sentry.flush(2_000).catch(() => {});
      await sql.end();
      await clickhouse.close();
    },
  };
};
