import {
  replicateCategories,
  type ReplicateCategoryConfig,
} from "../config/replicate-models";
import { env } from "../env";

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
          Input?: {
            properties?: Record<string, unknown>;
          };
        };
      };
    };
  };
};

export type ReplicateCategory = {
  name: string;
  models: ReplicateModel[];
};

type CategoriesCache = { data: ReplicateCategory[]; timestamp: number };

let categoriesCache: CategoriesCache | null = null;
let categoriesCacheFetch: Promise<ReplicateCategory[]> | null = null;

const CACHE_TTL = 10 * 60 * 1000;

export async function fetchReplicateCategories(): Promise<ReplicateCategory[]> {
  const now = Date.now();

  if (categoriesCache && now - categoriesCache.timestamp < CACHE_TTL) {
    return categoriesCache.data;
  }

  if (categoriesCacheFetch) {
    return categoriesCacheFetch;
  }

  categoriesCacheFetch = (async () => {
    const categories = await Promise.all(
      replicateCategories.map(async (category: ReplicateCategoryConfig) => {
        const models = await Promise.all(
          category.models.map(async (modelConfig) => {
            const response = await fetch(
              `https://api.replicate.com/v1/models/${modelConfig.id}`,
              { headers: { Authorization: `Bearer ${env.REPLICATE_API_KEY}` } },
            );
            return response.ok
              ? ((await response.json()) as ReplicateModel)
              : null;
          }),
        );

        return {
          name: category.name,
          models: models.filter((m): m is ReplicateModel => m !== null),
        };
      }),
    );

    categoriesCache = { data: categories, timestamp: now };
    categoriesCacheFetch = null;

    return categories;
  })();

  return categoriesCacheFetch;
}
