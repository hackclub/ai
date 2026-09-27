import type postgres from "postgres";

import type { AnalyticsQueries, GlobalRange, RecentRequest, RecentRequestFilters, RequestDetail, UsageStats } from "../analytics/queries";
import { listApiKeys } from "../auth/api-keys";
import type { SessionUser } from "../auth/sessions";
import type { Env } from "../env";
// The one lib/ import: the dashboard's model type. Catalog unification removes it.
import { type CatalogModel, type ModelCardData, modelTypeOf, stripMarkdownLinks } from "../lib/format";
import type { ModelCatalog } from "../models/catalog";
import type { ReplicateCatalog, ReplicateCover } from "../providers/replicate/catalog";

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

export type ActivityFilters = RecentRequestFilters;

export type ActivityRow = {
  requestId: string;
  occurredAt: string;
  provider: string;
  endpoint: string;
  model: string;
  modelName: string;
  /** OpenRouter routing variant, e.g. `nitro` for `openai/gpt-4o:nitro`. */
  variant: string | null;
  /** The dashboard page for the model, or null when there is none. */
  modelHref: string | null;
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

export type ReplicateCard = {
  owner: string;
  name: string;
  description: string;
  pricing: string | null;
  /** Same-origin thumbnail URL, or null when the model has no cover. */
  cover: string | null;
};

export type ReplicateCardCategory = { name: string; models: ReplicateCard[] };

export type GlobalPage = {
  range: GlobalRange;
  totals: { requests: number; tokens: number; users: number };
  models: { model: string; name: string; href: string | null; requests: number; tokens: number; share: number }[];
  authors: { author: string; tokens: number; share: number }[];
  /** Chart series in legend order; `model: ""` is everything outside the top models. */
  series: { model: string; name: string }[];
  /** Chart bars, oldest first, with tokens per series: the last 24 hours, 7 or 30 days, or every month. */
  bars: { start: string; total: number; tokens: Record<string, number> }[];
};

const GLOBAL_RANGES: GlobalRange[] = ["day", "week", "month", "all"];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const isoStart = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** UTC start of every chart bar in `range`; all time starts at the first month with usage. */
const barStarts = (range: GlobalRange, now: Date, first: string | undefined): string[] => {
  if (range === "day") {
    const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
    return Array.from({ length: 24 }, (_, index) => isoStart(hour - (23 - index) * HOUR_MS));
  }
  if (range === "all") {
    const from = first ? new Date(first) : now;
    const months: string[] = [];
    for (let year = from.getUTCFullYear(), month = from.getUTCMonth(); ; month += 1) {
      const start = Date.UTC(year, month, 1);
      if (start > now.getTime()) return months;
      months.push(isoStart(start));
    }
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const length = range === "week" ? 7 : 30;
  return Array.from({ length }, (_, index) => isoStart(today - (length - 1 - index) * DAY_MS));
};

export const parseGlobalRange = (value: string | null): GlobalRange =>
  GLOBAL_RANGES.find((range) => range === value) ?? "week";

export type ActivityDetail = ActivityRow &
  Pick<
    RequestDetail,
    | "httpStatus"
    | "streamed"
    | "timeToFirstByteMs"
    | "providerCostUsd"
    | "userAgent"
  >;

export type ActivityFilterOptions = {
  models: { id: string; name: string }[];
  keys: { id: string; name: string }[];
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

/** The activity filters in a page URL; unknown or malformed values are dropped. */
export const parseActivityFilters = (params: URLSearchParams): ActivityFilters => {
  const search = params.get("q")?.trim().slice(0, 200);
  const status = params.get("status");
  const apiKeyId = params.get("key");
  const model = params.get("model")?.slice(0, 200);
  return {
    ...(search ? { search } : {}),
    ...(status === "ok" || status === "error" ? { status } : {}),
    ...(apiKeyId && UUID.test(apiKeyId) ? { apiKeyId } : {}),
    ...(model ? { model } : {}),
  };
};

/** Models served by other providers have their own dashboard page. */
const PROVIDER_PAGES: Record<string, string> = {
  typesafe: "/jev",
  mistral: "/ocr",
  exa: "/exa",
  replicate: "/replicate",
};

async function dailySpending(sql: postgres.Sql, accountId: string): Promise<DailySpending> {
  const [row] = await sql<{ spent: string; granted: string }[]>`
    SELECT
      COALESCE(SUM(funding_window.committed_usd), 0)::text AS spent,
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
  async activity(
    user: SessionUser,
    options: { cursor?: ActivityCursor; filters?: ActivityFilters } = {},
  ): Promise<ActivityPage> {
    const [page, describe] = await Promise.all([
      this.deps.analytics.recentRequests(user.billingAccountId, {
        before: options.cursor,
        filters: options.filters,
      }),
      this.activityDescriber(user),
    ]);
    return { rows: page.requests.map(describe), next: page.next };
  }

  /** One request in full, or null when it is not the user's. */
  async activityRequest(user: SessionUser, requestId: string): Promise<ActivityDetail | null> {
    if (!UUID.test(requestId)) return null;
    const [request, describe] = await Promise.all([
      this.deps.analytics.requestDetail(user.billingAccountId, requestId),
      this.activityDescriber(user),
    ]);
    if (!request) return null;
    return {
      ...describe(request),
      httpStatus: request.httpStatus,
      streamed: request.streamed,
      timeToFirstByteMs: request.timeToFirstByteMs,
      providerCostUsd: request.providerCostUsd,
      userAgent: request.userAgent,
    };
  }

  /** The models and keys the activity filters offer. */
  async activityFilterOptions(user: SessionUser): Promise<ActivityFilterOptions> {
    const [models, keys, describe] = await Promise.all([
      this.deps.analytics.accountModels(user.billingAccountId),
      listApiKeys(this.deps.sql, user.id),
      this.modelDescriber(),
    ]);
    return {
      models: models.map((id) => {
        const { modelName, variant } = describe(id, "");
        return { id, name: variant ? `${modelName} (${variant})` : modelName };
      }),
      keys: keys.map((key) => ({ id: key.id, name: key.name })),
    };
  }

  private async activityDescriber(user: SessionUser) {
    const [keys, describeModel] = await Promise.all([
      listApiKeys(this.deps.sql, user.id),
      this.modelDescriber(),
    ]);
    const keyNames = new Map(keys.map((key) => [key.id, key.name]));
    return (request: RecentRequest): ActivityRow => ({
      requestId: request.requestId,
      occurredAt: request.occurredAt,
      provider: request.provider,
      endpoint: request.endpoint,
      model: request.model,
      ...describeModel(request.model, request.provider),
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
    });
  }

  /**
   * Names a recorded model id from the OpenRouter listings. A routing variant
   * (`:nitro`, `:floor`) is named after its base model, which is also where
   * it links; models of other providers link to that provider's page.
   */
  private async modelDescriber() {
    const listings = await this.listings();
    const names = new Map(
      [...listings.language, ...listings.embedding].map((model) => [model.id, model.name || model.id]),
    );
    return (model: string, provider: string) => {
      const listed = names.get(model);
      if (listed) return { modelName: listed, variant: null, modelHref: `/models/${model}` };
      const [base = model, ...rest] = model.split(":");
      const variant = rest.join(":") || null;
      const baseName = names.get(base);
      const modelHref = baseName ? `/models/${base}` : (PROVIDER_PAGES[provider] ?? null);
      return { modelName: baseName ?? base, variant, modelHref };
    };
  }

  /** Rankings and daily usage across every account, for the global stats page. */
  async globalUsage(range: GlobalRange, now = new Date()): Promise<GlobalPage> {
    const [overview, listings] = await Promise.all([this.deps.analytics.globalOverview(range), this.listings()]);
    const names = new Map(
      [...listings.language, ...listings.embedding].map((model) => [model.id, model.name || model.id]),
    );
    const nameOf = (model: string) => (model ? (names.get(model) ?? model) : "Other");
    const share = (tokens: number, total: number) => (total > 0 ? tokens / total : 0);
    const authorTotal = overview.authors.reduce((sum, row) => sum + row.tokens, 0);

    const seriesTokens = new Map<string, number>();
    for (const row of overview.buckets) seriesTokens.set(row.model, (seriesTokens.get(row.model) ?? 0) + row.tokens);
    const series = [...seriesTokens]
      .sort(([a, tokensA], [b, tokensB]) => (a === "" ? 1 : b === "" ? -1 : tokensB - tokensA))
      .map(([model]) => ({ model, name: nameOf(model) }));

    const bars = barStarts(range, now, overview.buckets[0]?.start).map((start) => ({
      start,
      total: 0,
      tokens: {} as Record<string, number>,
    }));
    const byStart = new Map(bars.map((bar) => [bar.start, bar]));
    for (const row of overview.buckets) {
      const bar = byStart.get(row.start);
      if (!bar) continue;
      bar.tokens[row.model] = row.tokens;
      bar.total += row.tokens;
    }

    return {
      range,
      totals: overview.totals,
      models: overview.models.map((row) => ({
        ...row,
        name: nameOf(row.model),
        href: names.has(row.model) ? `/models/${row.model}` : null,
        share: share(row.tokens, overview.totals.tokens),
      })),
      authors: overview.authors.map((row) => ({ ...row, share: share(row.tokens, authorTotal) })),
      series,
      bars,
    };
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

  /** The `/replicate` cards: only the fields a card renders. */
  async replicateCategories(): Promise<ReplicateCardCategory[]> {
    const categories = await this.deps.replicateCatalog.categories();
    return categories.map((category) => ({
      name: category.name,
      models: category.models.map((model) => ({
        owner: model.owner,
        name: model.name,
        description: model.description ?? "",
        pricing: model.pricing ?? null,
        cover: model.cover_image_url ? `/replicate/covers/${model.owner}/${model.name}` : null,
      })),
    }));
  }

  replicateCover(owner: string, name: string): Promise<ReplicateCover | null> {
    return this.deps.replicateCatalog.cover(owner, name);
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
