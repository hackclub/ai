import { Usd } from "../billing/money";

export type ModelKind = "language" | "embedding";

/** The subset of OpenRouter's model listing the gateway relies on. */
export type OpenRouterModel = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
  };
};

export type ModelPricing = {
  promptUsd: Usd;
  completionUsd: Usd;
  requestUsd: Usd;
  /** Null when neither the provider nor the model exposes a limit. */
  maxCompletionTokens: number | null;
};

export type ModelCatalogOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  ttlMs?: number;
  headers?: Record<string, string>;
  now?: () => number;
};

type CacheEntry = {
  models: OpenRouterModel[];
  fetchedAt: number;
};

type Listing = { data?: unknown };

const nonNegativePrice = (
  value: string | undefined,
  whenMissing: Usd | null,
): Usd | null => {
  if (value === undefined) return whenMissing;
  try {
    const parsed = Usd.parse(value);
    return parsed.isNegative() ? null : parsed;
  } catch {
    return null;
  }
};

/**
 * Prices are only usable when every component parses and is non-negative.
 * OpenRouter uses "-1" for models whose price is not fixed.
 */
export const modelPricing = (model: OpenRouterModel): ModelPricing | null => {
  // A listing without a token price is "unknown", not "free": the proxy
  // then places its unknown-model hold instead of reserving nothing.
  const promptUsd = nonNegativePrice(model.pricing?.prompt, null);
  const completionUsd = nonNegativePrice(model.pricing?.completion, null);
  const requestUsd = nonNegativePrice(model.pricing?.request, Usd.zero);
  if (!promptUsd || !completionUsd || !requestUsd) return null;

  const declared = model.top_provider?.max_completion_tokens;
  const maxCompletionTokens =
    typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0
      ? declared
      : null;

  return { promptUsd, completionUsd, requestUsd, maxCompletionTokens };
};

/**
 * Caches OpenRouter's model listings. Every model OpenRouter lists is
 * available through the gateway; there is deliberately no allowlist.
 * Fetches are single-flight per kind; a failed refresh serves the previous
 * listing when one exists so a transient upstream error does not take the
 * gateway down.
 */
export class ModelCatalog {
  private readonly fetchImplementation: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<ModelKind, CacheEntry>();
  private readonly inFlight = new Map<ModelKind, Promise<OpenRouterModel[]>>();

  constructor(private readonly options: ModelCatalogOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1_000;
    this.now = options.now ?? Date.now;
  }

  async list(kind: ModelKind): Promise<OpenRouterModel[]> {
    const cached = this.cache.get(kind);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
      return cached.models;
    }

    const pending = this.inFlight.get(kind);
    if (pending) return pending;

    const refresh = this.refresh(kind)
      .catch((error) => {
        if (cached) return cached.models;
        throw error;
      })
      .finally(() => this.inFlight.delete(kind));
    this.inFlight.set(kind, refresh);
    return refresh;
  }

  async find(kind: ModelKind, id: string): Promise<OpenRouterModel | null> {
    const models = await this.list(kind);
    return models.find((model) => model.id === id) ?? null;
  }

  private async refresh(kind: ModelKind): Promise<OpenRouterModel[]> {
    const path = kind === "embedding" ? "/v1/embeddings/models" : "/v1/models";
    const response = await this.fetchImplementation(
      `${this.options.baseUrl.replace(/\/$/, "")}${path}`,
      {
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          ...(this.options.headers ?? {}),
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `OpenRouter model listing failed with HTTP ${response.status}`,
      );
    }

    const listing = (await response.json()) as Listing;
    if (!Array.isArray(listing.data)) {
      throw new Error("OpenRouter model listing did not contain a data array");
    }

    const models = (listing.data as OpenRouterModel[]).filter(
      (model) => typeof model?.id === "string",
    );

    this.cache.set(kind, { models, fetchedAt: this.now() });
    return models;
  }
}
