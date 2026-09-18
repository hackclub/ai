import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";

export type HealthOptions = {
  sql: postgres.Sql;
  clickhouse: ClickHouseClient;
  openRouter: { apiKey: string; baseUrl: string; fetch?: typeof fetch };
  /**
   * Replicate's unused-credit scrape, as the previous gateway did it. Needs a
   * browser session cookie; skipped when either value is missing.
   */
  replicate?: { username: string; sessionId: string } | null;
  cacheMs?: number;
  now?: () => number;
};

export type HealthReport = {
  status: "up" | "down";
  postgres: boolean;
  clickhouse: boolean;
  openRouter: boolean;
  /** OpenRouter credits purchased minus used, as the previous gateway reported. */
  balanceRemaining?: number;
  /** Remaining spend allowed on the shared key; the previous gateway's name. */
  dailyKeyUsageRemaining?: number;
  keyLimitRemaining?: number;
  keyUsage?: number;
  replicateUnusedCredit?: number;
  timestamp: number;
};

/** Replicate credit below this makes the service report down, as before. */
const REPLICATE_MIN_CREDIT = 0.6;

const numberOrUndefined = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * GET /up. Checks PostgreSQL, ClickHouse, and OpenRouter and caches the
 * verdict so a probe storm cannot amplify load. The previous gateway's
 * balance and Replicate credit fields are kept for monitors that read them.
 */
export const createHealthCheck = (options: HealthOptions) => {
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? Date.now;
  const fetchImplementation = options.openRouter.fetch ?? fetch;
  const openRouterBase = options.openRouter.baseUrl.replace(/\/$/, "");
  const openRouterHeaders = { authorization: `Bearer ${options.openRouter.apiKey}` };
  let cached: HealthReport | null = null;

  const keyStatus = () =>
    fetchImplementation(`${openRouterBase}/v1/key`, { headers: openRouterHeaders })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = (await response.json()) as {
          data?: { limit_remaining?: number | null; usage?: number };
        };
        return {
          limitRemaining: numberOrUndefined(body.data?.limit_remaining),
          usage: numberOrUndefined(body.data?.usage),
        };
      })
      .catch(() => null);

  const credits = () =>
    fetchImplementation(`${openRouterBase}/v1/credits`, { headers: openRouterHeaders })
      .then(async (response) => {
        if (!response.ok) return undefined;
        const body = (await response.json()) as {
          data?: { total_credits?: number; total_usage?: number };
        };
        const total = numberOrUndefined(body.data?.total_credits);
        const used = numberOrUndefined(body.data?.total_usage);
        return total === undefined || used === undefined ? undefined : total - used;
      })
      .catch(() => undefined);

  const replicateCredit = () => {
    if (!options.replicate) return Promise.resolve(undefined);
    const { username, sessionId } = options.replicate;
    return fetchImplementation(
      `https://replicate.com/api/users/${encodeURIComponent(username)}/unused-credit`,
      { headers: { cookie: `sessionid=${sessionId}` } },
    )
      .then(async (response) => {
        if (!response.ok) return undefined;
        const body = (await response.json()) as { unused_credit?: string | number };
        const credit = Number(body.unused_credit);
        return Number.isFinite(credit) ? credit : undefined;
      })
      .catch(() => undefined);
  };

  const check = async (): Promise<HealthReport> => {
    const [postgresOk, clickhouseOk, key, balanceRemaining, replicateUnusedCredit] =
      await Promise.all([
        options.sql`SELECT 1`.then(() => true, () => false),
        options.clickhouse
          .query({ query: "SELECT 1", format: "JSONEachRow" })
          .then(() => true, () => false),
        keyStatus(),
        credits(),
        replicateCredit(),
      ]);

    const openRouterOk = key !== null;
    const replicateOk =
      !options.replicate ||
      (replicateUnusedCredit !== undefined && replicateUnusedCredit > REPLICATE_MIN_CREDIT);

    return {
      status: postgresOk && clickhouseOk && openRouterOk && replicateOk ? "up" : "down",
      postgres: postgresOk,
      clickhouse: clickhouseOk,
      openRouter: openRouterOk,
      ...(balanceRemaining !== undefined ? { balanceRemaining } : {}),
      ...(key?.limitRemaining !== undefined
        ? { dailyKeyUsageRemaining: key.limitRemaining, keyLimitRemaining: key.limitRemaining }
        : {}),
      ...(key?.usage !== undefined ? { keyUsage: key.usage } : {}),
      ...(replicateUnusedCredit !== undefined ? { replicateUnusedCredit } : {}),
      timestamp: now(),
    };
  };

  return async (): Promise<Response> => {
    if (!cached || now() - cached.timestamp >= cacheMs) cached = await check();
    return Response.json(cached, { status: cached.status === "up" ? 200 : 503 });
  };
};
