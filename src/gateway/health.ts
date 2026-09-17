import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

export type HealthOptions = {
  sql: postgres.Sql;
  clickhouse: ClickHouseClient;
  openRouter: { apiKey: string; baseUrl: string; fetch?: typeof fetch };
  cacheMs?: number;
  now?: () => number;
};

export type HealthReport = {
  status: "up" | "down";
  postgres: boolean;
  clickhouse: boolean;
  openRouter: boolean;
  keyLimitRemaining?: number;
  keyUsage?: number;
  timestamp: number;
};

/**
 * GET /up. Checks the three dependencies and caches the verdict so a probe
 * storm cannot amplify load. Unlike the previous gateway it neither scrapes
 * Replicate credit nor needs a provisioning key.
 */
export const createHealthCheck = (options: HealthOptions) => {
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? Date.now;
  const fetchImplementation = options.openRouter.fetch ?? fetch;
  let cached: HealthReport | null = null;

  const check = async (): Promise<HealthReport> => {
    const [postgresOk, clickhouseOk, key] = await Promise.all([
      options.sql`SELECT 1`.then(() => true, () => false),
      options.clickhouse
        .query({ query: "SELECT 1", format: "JSONEachRow" })
        .then(() => true, () => false),
      fetchImplementation(`${options.openRouter.baseUrl.replace(/\/$/, "")}/v1/key`, {
        headers: { authorization: `Bearer ${options.openRouter.apiKey}` },
      })
        .then(async (response) => {
          if (!response.ok) return null;
          const body = (await response.json()) as {
            data?: { limit_remaining?: number | null; usage?: number };
          };
          return {
            limitRemaining:
              typeof body.data?.limit_remaining === "number"
                ? body.data.limit_remaining
                : undefined,
            usage: typeof body.data?.usage === "number" ? body.data.usage : undefined,
          };
        })
        .catch(() => null),
    ]);

    const openRouterOk = key !== null;
    return {
      status: postgresOk && clickhouseOk && openRouterOk ? "up" : "down",
      postgres: postgresOk,
      clickhouse: clickhouseOk,
      openRouter: openRouterOk,
      ...(key?.limitRemaining !== undefined ? { keyLimitRemaining: key.limitRemaining } : {}),
      ...(key?.usage !== undefined ? { keyUsage: key.usage } : {}),
      timestamp: now(),
    };
  };

  return async (): Promise<Response> => {
    if (!cached || now() - cached.timestamp >= cacheMs) cached = await check();
    return Response.json(cached, { status: cached.status === "up" ? 200 : 503 });
  };
};
