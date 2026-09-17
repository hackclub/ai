import {
  type ReplicateCategoryConfig,
  replicateCategories,
} from "../../config/replicate-models";

export type ReplicateModel = {
  url: string;
  owner: string;
  name: string;
  description: string;
  visibility: string;
  github_url?: string;
  paper_url?: string;
  license_url?: string;
  run_count?: number;
  cover_image_url?: string;
  default_example?: {
    input?: Record<string, unknown>;
    output?: unknown;
  };
  latest_version?: {
    id: string;
    created_at: string;
    cog_version?: string;
    openapi_schema?: {
      components?: {
        schemas?: {
          Input?: { properties?: Record<string, unknown> };
        };
      };
    };
  };
};

export type ReplicateCategory = { name: string; models: ReplicateModel[] };

export type ReplicateCatalogOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  ttlMs?: number;
  baseUrl?: string;
};

/**
 * Fetches the curated Replicate models grouped by category, with a
 * ten-minute single-flight cache. Models that Replicate does not return are
 * dropped from their category rather than failing the whole listing.
 */
export const createReplicateCatalog = (options: ReplicateCatalogOptions) => {
  const fetchImplementation = options.fetch ?? fetch;
  const ttlMs = options.ttlMs ?? 10 * 60 * 1_000;
  const baseUrl = (options.baseUrl ?? "https://api.replicate.com").replace(/\/$/, "");
  let cache: { data: ReplicateCategory[]; fetchedAt: number } | null = null;
  let inFlight: Promise<ReplicateCategory[]> | null = null;

  const refresh = async () => {
    const categories = await Promise.all(
      replicateCategories.map(async (category: ReplicateCategoryConfig) => {
        const models = await Promise.all(
          category.models.map(async (model) => {
            const response = await fetchImplementation(
              `${baseUrl}/v1/models/${model.id}`,
              { headers: { authorization: `Bearer ${options.apiKey}` } },
            );
            return response.ok ? ((await response.json()) as ReplicateModel) : null;
          }),
        );
        return {
          name: category.name,
          models: models.filter((model): model is ReplicateModel => model !== null),
        };
      }),
    );
    cache = { data: categories, fetchedAt: Date.now() };
    return categories;
  };

  return {
    async categories(): Promise<ReplicateCategory[]> {
      if (cache && Date.now() - cache.fetchedAt < ttlMs) return cache.data;
      if (inFlight) return inFlight;
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
};

export type ReplicateCatalog = ReturnType<typeof createReplicateCatalog>;
