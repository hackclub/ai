import {
  allowedEmbeddingModels,
  allowedImageModels,
  allowedLanguageModels,
  env,
} from "../env";

export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
};

type OpenRouterModelsResponse = { data: OpenRouterModel[] };

type ModelsCache = { data: OpenRouterModelsResponse; timestamp: number };

type ModelsCacheState = {
  cache: ModelsCache | null;
  fetchPromise: Promise<OpenRouterModelsResponse> | null;
};

const cacheState: Record<string, ModelsCacheState> = {
  language: { cache: null, fetchPromise: null },
  image: { cache: null, fetchPromise: null },
  embedding: { cache: null, fetchPromise: null },
};

const CACHE_TTL = 5 * 60 * 1000;

export const openRouterHeaders = {
  "HTTP-Referer": `${env.BASE_URL}/global?utm_source=openrouter`,
  "X-Title": "Hack Club AI",
};

function createModelsFetcher(
  key: string,
  endpoint: string,
  allowedModels: string[],
): () => Promise<OpenRouterModelsResponse> {
  return async () => {
    const state = cacheState[key];
    const now = Date.now();

    if (state.cache && now - state.cache.timestamp < CACHE_TTL) {
      return state.cache.data;
    }

    if (state.fetchPromise) {
      return state.fetchPromise;
    }

    state.fetchPromise = (async () => {
      try {
        const response = await fetch(`${env.OPENAI_API_URL}${endpoint}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            ...openRouterHeaders,
          },
        });

        const data = (await response.json()) as OpenRouterModelsResponse;

        if (!response.ok || !data.data || !Array.isArray(data.data)) {
          state.fetchPromise = null;
          return data;
        }

        const orderMap = new Map(allowedModels.map((id, index) => [id, index]));
        data.data = data.data
          .filter((model) => orderMap.has(model.id))
          .sort(
            (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
          );

        state.cache = { data, timestamp: now };
        state.fetchPromise = null;

        return data;
      } catch (error) {
        state.fetchPromise = null;
        throw error;
      }
    })();

    return state.fetchPromise;
  };
}

export const fetchLanguageModels = createModelsFetcher(
  "language",
  "/v1/models",
  allowedLanguageModels,
);

export const fetchImageModels = createModelsFetcher(
  "image",
  "/v1/models",
  allowedImageModels,
);

export const fetchEmbeddingModels = createModelsFetcher(
  "embedding",
  "/v1/embeddings/models",
  allowedEmbeddingModels,
);

type AllModelsResponse = {
  languageModels: OpenRouterModel[];
  imageModels: OpenRouterModel[];
  embeddingModels: OpenRouterModel[];
};

export async function fetchAllModels(): Promise<AllModelsResponse> {
  const [languageModelsResponse, imageModelsResponse, embeddingModelsResponse] =
    await Promise.all([
      fetchLanguageModels(),
      fetchImageModels(),
      fetchEmbeddingModels(),
    ]);

  return {
    languageModels: languageModelsResponse.data,
    imageModels: imageModelsResponse.data,
    embeddingModels: embeddingModelsResponse.data,
  };
}
