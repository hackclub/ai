import { memoAsync } from "../../cache/memo-async";
import {
  type ReplicateCategoryConfig,
  replicateCategories,
} from "../../config/replicate-models";
import {
  createReplicatePricingSource,
  describePricing,
  type ReplicatePricingSource,
} from "./pricing";

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
  /** Human pricing summary from Replicate's live pricing, when available. */
  pricing?: string;
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
  pricing?: ReplicatePricingSource;
};

export const createReplicateCatalog = (options: ReplicateCatalogOptions) => {
  const fetchImplementation = options.fetch ?? fetch;
  const ttlMs = options.ttlMs ?? 10 * 60 * 1_000;
  const baseUrl = (options.baseUrl ?? "https://api.replicate.com").replace(/\/$/, "");
  const pricingSource =
    options.pricing ?? createReplicatePricingSource({ fetch: fetchImplementation });

  const pricingSummary = async (modelId: string) => {
    try {
      const pricing = await pricingSource.get(modelId);
      return pricing ? describePricing(pricing) : undefined;
    } catch {
      return undefined;
    }
  };

  const refresh = async (_key: "categories") => {
    const categories = await Promise.all(
      replicateCategories.map(async (category: ReplicateCategoryConfig) => {
        const models = await Promise.all(
          category.models.map(async (model) => {
            const [response, pricing] = await Promise.all([
              fetchImplementation(`${baseUrl}/v1/models/${model.id}`, {
                headers: { authorization: `Bearer ${options.apiKey}` },
              }),
              pricingSummary(model.id),
            ]);
            if (!response.ok) return null;
            const data = (await response.json()) as ReplicateModel;
            return pricing ? { ...data, pricing } : data;
          }),
        );
        // Replicate aliases renamed models (e.g. inworld/tts-1.5-mini now
        // resolves to inworld/realtime-tts-1.5-mini), so two configured IDs can
        // return the same model. Keep the first occurrence per owner/name.
        const seen = new Set<string>();
        return {
          name: category.name,
          models: models.filter((model): model is ReplicateModel => {
            if (model === null) return false;
            const key = `${model.owner}/${model.name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        };
      }),
    );
    return categories;
  };

  const memo = memoAsync<"categories", ReplicateCategory[]>(refresh, { ttlMs });

  return {
    categories(): Promise<ReplicateCategory[]> {
      return memo.get("categories");
    },
  };
};

export type ReplicateCatalog = ReturnType<typeof createReplicateCatalog>;
