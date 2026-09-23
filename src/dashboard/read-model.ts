import type postgres from "postgres";

import type { AnalyticsQueries, ModelUsageStats, UsageStats } from "../analytics/queries";
import { listApiKeys } from "../auth/api-keys";
import type { SessionUser } from "../auth/sessions";
import type { Env } from "../env";
// The one lib/ import: the dashboard's model type. Catalog unification removes it.
import { type CatalogModel, type ModelCardData, modelTypeOf, stripMarkdownLinks } from "../lib/format";
import type { ModelCatalog } from "../models/catalog";
import type { ReplicateCatalog, ReplicateCategory } from "../providers/replicate/catalog";

export type DashboardEnv = Pick<
  Env,
  "nodeEnv" | "baseUrl" | "enforceIdv" | "featuredModels" | "mistralOcrPagePriceUsd" | "typesafeInputPricePerMillionUsd"
>;

export type DashboardDependencies = {
  sql: postgres.Sql;
  analytics: AnalyticsQueries;
  catalog: ModelCatalog;
  replicateCatalog: ReplicateCatalog;
  env: DashboardEnv;
};

/** Static, non-secret deployment facts pages render. */
export type Site = {
  baseUrl: string;
  devMode: boolean;
  enforceIdv: boolean;
  featuredModels: string[];
  featuredModel: string;
  ocrPagePriceUsd: string;
  jevInputPricePerMillionUsd: string;
};

export type DailySpending = {
  spentUsd: string;
  limitUsd: string;
};

export type DashboardKey = {
  id: string;
  name: string;
  keyPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type ActivityCursor = { before: string; beforeId: string };

export type ActivityRow = {
  requestId: string;
  occurredAt: string;
  model: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  billedCostUsd: string;
  durationMs: number;
  error: string | null;
  apiKeyName: string;
  ip: string;
};

export type ActivityPage = {
  rows: ActivityRow[];
  next: ActivityCursor | null;
};

export type GroupedModels = {
  languageModels: CatalogModel[];
  imageModels: CatalogModel[];
  embeddingModels: CatalogModel[];
};

export type GroupedModelCards = {
  languageModels: ModelCardData[];
  imageModels: ModelCardData[];
  embeddingModels: ModelCardData[];
};

/** The model the dashboard's examples use. */
export const featuredModel = (models: readonly string[]) => models[0] ?? "openai/gpt-4o-mini";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `/activity/requests` cursor, normalized to ISO 8601, or null when missing or malformed. */
export const parseActivityCursor = (params: URLSearchParams): ActivityCursor | null => {
  const before = params.get("before");
  const beforeId = params.get("beforeId");
  const beforeAt = before ? new Date(before) : null;
  if (!beforeAt || Number.isNaN(beforeAt.getTime()) || !beforeId || !UUID.test(beforeId)) {
    return null;
  }
  // Normalized to ISO 8601 so ClickHouse parses exactly what JavaScript did.
  return { before: beforeAt.toISOString(), beforeId };
};

async function dailySpending(sql: postgres.Sql, accountId: string): Promise<DailySpending> {
  const [row] = await sql<{ spent: string; granted: string }[]>`
    SELECT
      COALESCE(SUM(funding_window.committed_usd + funding_window.reserved_usd), 0)::text AS spent,
      COALESCE(SUM(funding_window.granted_usd), 0)::text AS granted
    FROM billing_funding_windows AS funding_window
    JOIN billing_funding_policies AS policy ON policy.id = funding_window.policy_id
    WHERE
      funding_window.account_id = ${accountId}::uuid
      AND policy.cadence = 'day'
      AND funding_window.superseded_at IS NULL
      AND funding_window.window_start <= now()
      AND funding_window.window_end > now()
  `;
  const [policy] = await sql<{ amount: string }[]>`
    SELECT COALESCE(SUM(amount_usd), 0)::text AS amount
    FROM billing_funding_policies
    WHERE account_id = ${accountId}::uuid AND cadence = 'day' AND enabled
  `;
  return {
    spentUsd: row?.spent ?? "0",
    // Before the first request of the day no window exists yet; fall back to
    // the policy amount so the header shows the real allowance.
    limitUsd: row && Number(row.granted) > 0 ? row.granted : (policy?.amount ?? "0"),
  };
}

const toCard = (model: CatalogModel): ModelCardData => ({
  id: model.id,
  name: model.name,
  // The card clamps to two lines; 240 characters is more than it can show.
  description: stripMarkdownLinks(model.description ?? "").slice(0, 240),
});

/**
 * Everything a SvelteKit loader reads. Built once in `createBackend`; loaders
 * reach it through `locals.dashboard` and never import backend modules.
 */
export class DashboardReadModel {
  readonly site: Site;
  private readonly deps: DashboardDependencies;

  constructor(deps: DashboardDependencies) {
    this.deps = deps;
    const { env } = deps;
    this.site = {
      baseUrl: env.baseUrl,
      devMode: env.nodeEnv === "development",
      enforceIdv: env.enforceIdv,
      featuredModels: env.featuredModels,
      featuredModel: featuredModel(env.featuredModels),
      ocrPagePriceUsd: env.mistralOcrPagePriceUsd,
      jevInputPricePerMillionUsd: env.typesafeInputPricePerMillionUsd,
    };
  }

  /** Today's spend against the daily allowance, for the header. */
  spending(user: SessionUser): Promise<DailySpending> {
    return dailySpending(this.deps.sql, user.billingAccountId);
  }

  /** The user's active keys, newest first, with the secret masked. */
  async keys(user: SessionUser): Promise<DashboardKey[]> {
    const keys = await listApiKeys(this.deps.sql, user.id);
    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPreview: `${key.keyPrefix}••••••••`,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    }));
  }

  usage(user: SessionUser): Promise<UsageStats> {
    return this.deps.analytics.userStats(user.billingAccountId);
  }

  /** Recent requests for the activity page, enriched with key and model names. */
  async activity(user: SessionUser, cursor?: ActivityCursor): Promise<ActivityPage> {
    const [page, keys, listings] = await Promise.all([
      this.deps.analytics.recentRequests(user.billingAccountId, { before: cursor }),
      listApiKeys(this.deps.sql, user.id),
      this.listings(),
    ]);
    const keyNames = new Map(keys.map((key) => [key.id, key.name]));
    const names = new Map(
      [...listings.language, ...listings.embedding].map((model) => [model.id, model.name || model.id]),
    );
    return {
      rows: page.requests.map((request) => ({
        requestId: request.requestId,
        occurredAt: request.occurredAt,
        model: request.model,
        modelName: names.get(request.model) ?? request.model,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        billedCostUsd: request.billedCostUsd,
        durationMs: request.durationMs,
        error:
          request.outcome === "completed"
            ? null
            : request.errorCode || request.outcome.replaceAll("_", " "),
        apiKeyName: (request.apiKeyId && keyNames.get(request.apiKeyId)) || "revoked key",
        ip: request.ip,
      })),
      next: page.next,
    };
  }

  async globalUsage(): Promise<{ globalStats: UsageStats; modelStats: ModelUsageStats[] }> {
    const [globalStats, modelStats] = await Promise.all([
      this.deps.analytics.globalStats(),
      this.deps.analytics.modelStats(),
    ]);
    return { globalStats, modelStats };
  }

  /** The `/models` cards: only the fields a card renders. */
  async modelCards(): Promise<GroupedModelCards> {
    const groups = await this.groupedModels();
    return {
      languageModels: groups.languageModels.map(toCard),
      imageModels: groups.imageModels.map(toCard),
      embeddingModels: groups.embeddingModels.map(toCard),
    };
  }

  /** One listed model in full, or null when the catalog does not list it. */
  async model(id: string): Promise<CatalogModel | null> {
    const groups = await this.groupedModels();
    return (
      [...groups.languageModels, ...groups.imageModels, ...groups.embeddingModels].find(
        (candidate) => candidate.id === id,
      ) ?? null
    );
  }

  replicateCategories(): Promise<ReplicateCategory[]> {
    return this.deps.replicateCatalog.categories();
  }

  /** Both OpenRouter listings; a listing failure reads as empty rather than a broken page. */
  private async listings(): Promise<{ language: CatalogModel[]; embedding: CatalogModel[] }> {
    try {
      const [language, embedding] = await Promise.all([
        this.deps.catalog.list("language") as Promise<CatalogModel[]>,
        this.deps.catalog.list("embedding") as Promise<CatalogModel[]>,
      ]);
      return { language, embedding };
    } catch {
      return { language: [], embedding: [] };
    }
  }

  /** Catalog models grouped the way the dashboard presents them. */
  private async groupedModels(): Promise<GroupedModels> {
    const { language, embedding } = await this.listings();
    return {
      languageModels: language.filter((model) => modelTypeOf(model) === "language"),
      imageModels: language.filter((model) => modelTypeOf(model) === "image"),
      embeddingModels: [
        ...embedding,
        ...language.filter((model) => modelTypeOf(model) === "embedding"),
      ],
    };
  }
}
