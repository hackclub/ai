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
import { RateLimiter } from "./gateway/rate-limit";
import { exaRoutes } from "./gateway/routes/exa";
import { imagesRoutes } from "./gateway/routes/images";
import { jevRoutes } from "./gateway/routes/jev";
import { moderationRoutes } from "./gateway/routes/moderations";
import { ocrRoutes } from "./gateway/routes/ocr";
import { replicateRoutes } from "./gateway/routes/replicate";
import { webhookRoutes } from "./gateway/webhooks";
import { ModelCatalog } from "./models/catalog";
import { OpenRouterAdapter } from "./providers/openrouter/adapter";

export type Backend = {
  app: ReturnType<typeof createApp>;
  sql: postgres.Sql;
  clickhouse: ClickHouseClient;
  billing: BillingEngine;
  catalog: ModelCatalog;
  queries: AnalyticsQueries;
  env: Env;
  /** Starts the job worker; idempotent. */
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
};

const notifySlack = (webhookUrl: string) => async (payload: unknown) => {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Slack webhook failed with status ${response.status}`);
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
  const billing = new BillingEngine(sql);
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
    console.error(`Billing settlement failed for request ${requestId}:`, error);
    Sentry.captureException(error, { tags: { requestId, stage: "billing.settle" } });
  };
  const metered = { sql, billing, enforceIdv: env.enforceIdv, rateLimiter, onSettlementError };

  const routes: AnyElysia[] = [
    exaRoutes({ ...metered, exaApiKey: env.exaApiKey }),
    ocrRoutes({
      ...metered,
      mistralApiKey: env.mistralApiKey,
      perPagePriceUsd: env.mistralOcrPagePriceUsd,
    }),
    jevRoutes({
      ...metered,
      typesafeApiKey: env.typesafeApiKey,
      inputPricePerMillionTokensUsd: env.typesafeInputPricePerMillionUsd,
    }),
    moderationRoutes({
      sql,
      enforceIdv: env.enforceIdv,
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
    keysApiRoutes({ sql }),
    webhookRoutes({ sql }),
  ];
  if (env.replicateApiKey) {
    routes.push(
      replicateRoutes({
        ...metered,
        replicateApiKey: env.replicateApiKey,
        publicBaseUrl: env.baseUrl,
      }),
    );
  }
  if (env.hackClubClientId && env.hackClubClientSecret) {
    const slack = env.slackGeoblockWebhookUrl
      ? notifySlack(env.slackGeoblockWebhookUrl)
      : null;
    routes.push(
      hackClubAuthRoutes({
        sql,
        clientId: env.hackClubClientId,
        clientSecret: env.hackClubClientSecret,
        baseUrl: env.baseUrl,
        secureCookies: env.nodeEnv === "production",
        onFlaggedCountry: async (identity) => {
          if (!slack) return;
          const primary =
            identity.addresses?.find((address) => address.primary) ??
            identity.addresses?.[0];
          const name = `${identity.first_name} ${identity.last_name}`.trim() || "Unknown";
          await slack({
            text: `Blocked address country detected for ${identity.slack_id} (${primary?.country ?? "unknown"})`,
            blocks: [
              { type: "header", text: { type: "plain_text", text: "Blocked address country detected" } },
              {
                type: "section",
                fields: [
                  { type: "mrkdwn", text: `*Name:*\n${name}` },
                  { type: "mrkdwn", text: `*Email:*\n${identity.primary_email}` },
                  { type: "mrkdwn", text: `*Slack ID:*\n${identity.slack_id}` },
                  { type: "mrkdwn", text: `*Country:*\n${primary?.country ?? "unknown"}` },
                ],
              },
            ],
          });
        },
      }),
    );
  }

  const app = createApp({
    onError: (error) => {
      console.error("Unhandled request error:", error);
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
    catalog,
    queries,
    env,
    start: async () => {
      // Also creates the job-queue schema, which finalization depends on.
      worker ??= await startAnalyticsWorker({
        connectionString: env.databaseUrl,
        clickhouse,
        reconciliation: { sql, billing, openRouter },
        log: (message) => console.log(`[billing.reconcile] ${message}`),
      });
    },
    shutdown: async () => {
      await worker?.stop();
      await Sentry.flush(2_000).catch(() => {});
      await sql.end();
      await clickhouse.close();
    },
  };
};
