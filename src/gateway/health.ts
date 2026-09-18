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
  /** Mistral (OCR). Skipped when no key is configured. */
  mistral?: { apiKey: string; baseUrl?: string } | null;
  /** Exa. Skipped when no key is configured. */
  exa?: { apiKey: string; baseUrl?: string } | null;
  cacheMs?: number;
  now?: () => number;
  /** Returns the error that stopped background services from starting, or null. */
  startupError?: () => Error | null;
};

export type HealthReport = {
  status: "up" | "down";
  postgres: boolean;
  clickhouse: boolean;
  openRouter: boolean;
  /** False when the job worker or outbox drainer failed to start. */
  startup: boolean;
  /** Present only when the provider is configured. */
  mistral?: boolean;
  exa?: boolean;
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
 * GET /up. Checks PostgreSQL, ClickHouse, OpenRouter, and any configured
 * provider (Mistral, Exa, Replicate) and caches the verdict so a probe storm
 * cannot amplify load. The previous gateway's balance and Replicate credit
 * fields are kept for monitors that read them.
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

  /** Authenticated listing; a rejected key answers 401. */
  const mistralOk = () => {
    if (!options.mistral) return Promise.resolve(undefined);
    const base = (options.mistral.baseUrl ?? "https://api.mistral.ai").replace(/\/$/, "");
    return fetchImplementation(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${options.mistral.apiKey}` },
    })
      .then((response) => response.ok)
      .catch(() => false);
  };

  /**
   * Exa has no key-status endpoint and every real search is billed, so send
   * an empty search body: the key is checked first, so a good key answers
   * 400 (invalid body) and a bad one 401, without running a search.
   */
  const exaOk = () => {
    if (!options.exa) return Promise.resolve(undefined);
    const base = (options.exa.baseUrl ?? "https://api.exa.ai").replace(/\/$/, "");
    return fetchImplementation(`${base}/search`, {
      method: "POST",
      headers: { "x-api-key": options.exa.apiKey, "content-type": "application/json" },
      body: "{}",
    })
      .then((response) => response.ok || response.status === 400)
      .catch(() => false);
  };

  const check = async (): Promise<HealthReport> => {
    const [postgresOk, clickhouseOk, key, balanceRemaining, replicateUnusedCredit, mistral, exa] =
      await Promise.all([
        options.sql`SELECT 1`.then(() => true, () => false),
        options.clickhouse
          .query({ query: "SELECT 1", format: "JSONEachRow" })
          .then(() => true, () => false),
        keyStatus(),
        credits(),
        replicateCredit(),
        mistralOk(),
        exaOk(),
      ]);

    const openRouterOk = key !== null;
    const replicateOk =
      !options.replicate ||
      (replicateUnusedCredit !== undefined && replicateUnusedCredit > REPLICATE_MIN_CREDIT);

    const providersOk = mistral !== false && exa !== false;
    const startupOk = (options.startupError?.() ?? null) === null;

    return {
      status:
        postgresOk && clickhouseOk && openRouterOk && replicateOk && providersOk && startupOk
          ? "up"
          : "down",
      postgres: postgresOk,
      clickhouse: clickhouseOk,
      openRouter: openRouterOk,
      startup: startupOk,
      ...(mistral !== undefined ? { mistral } : {}),
      ...(exa !== undefined ? { exa } : {}),
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
