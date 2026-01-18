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

let languageModelsCache: ModelsCache | null = null;
let languageModelsCacheFetch: Promise<OpenRouterModelsResponse> | null = null;

let imageModelsCache: ModelsCache | null = null;
let imageModelsCacheFetch: Promise<OpenRouterModelsResponse> | null = null;

let embeddingModelsCache: ModelsCache | null = null;
let embeddingModelsCacheFetch: Promise<OpenRouterModelsResponse> | null = null;

let imageModelsCache: ModelsCache | null = null;
let imageModelsCacheFetch: Promise<OpenRouterModelsResponse> | null = null;

const CACHE_TTL = 5 * 60 * 1000;

const openRouterHeaders = {
  "HTTP-Referer": `${env.BASE_URL}/global?utm_source=openrouter`,
  "X-Title": "Hack Club AI",
};

export async function fetchLanguageModels(): Promise<OpenRouterModelsResponse> {
  const now = Date.now();

  if (languageModelsCache && now - languageModelsCache.timestamp < CACHE_TTL) {
    return languageModelsCache.data;
  }

  if (languageModelsCacheFetch) {
    return languageModelsCacheFetch;
  }

  languageModelsCacheFetch = (async () => {
    try {
      const response = await fetch(`${env.OPENAI_API_URL}/v1/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          ...openRouterHeaders,
        },
      });

      const data = (await response.json()) as OpenRouterModelsResponse;

      if (!response.ok || !data.data || !Array.isArray(data.data)) {
        languageModelsCacheFetch = null;
        return data;
      }

      const orderMap = new Map(
        allowedLanguageModels.map((id, index) => [id, index]),
      );
      data.data = data.data
        .filter((model) => orderMap.has(model.id))
        .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

      languageModelsCache = { data, timestamp: now };
      languageModelsCacheFetch = null;

      return data;
    } catch (error) {
      languageModelsCacheFetch = null;
      throw error;
    }
  })();

  return languageModelsCacheFetch;
}

export async function fetchImageModels(): Promise<OpenRouterModelsResponse> {
  const now = Date.now();

  if (imageModelsCache && now - imageModelsCache.timestamp < CACHE_TTL) {
    return imageModelsCache.data;
  }

  if (imageModelsCacheFetch) {
    return imageModelsCacheFetch;
  }

  imageModelsCacheFetch = (async () => {
    try {
      const response = await fetch(`${env.OPENAI_API_URL}/v1/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          ...openRouterHeaders,
        },
      });

      const data = (await response.json()) as OpenRouterModelsResponse;

      if (!response.ok || !data.data || !Array.isArray(data.data)) {
        imageModelsCacheFetch = null;
        return data;
      }

      const orderMap = new Map(
        allowedImageModels.map((id, index) => [id, index]),
      );
      data.data = data.data
        .filter((model) => orderMap.has(model.id))
        .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

      imageModelsCache = { data, timestamp: now };
      imageModelsCacheFetch = null;

      return data;
    } catch (error) {
      imageModelsCacheFetch = null;
      throw error;
    }
  })();

  return imageModelsCacheFetch;
}

export async function fetchEmbeddingModels(): Promise<OpenRouterModelsResponse> {
  const now = Date.now();

  if (
    embeddingModelsCache &&
    now - embeddingModelsCache.timestamp < CACHE_TTL
  ) {
    return embeddingModelsCache.data;
  }

  if (embeddingModelsCacheFetch) {
    return embeddingModelsCacheFetch;
  }

  embeddingModelsCacheFetch = (async () => {
    try {
      const response = await fetch(
        `${env.OPENAI_API_URL}/v1/embeddings/models`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            ...openRouterHeaders,
          },
        },
      );

      const data = (await response.json()) as OpenRouterModelsResponse;

      if (!response.ok || !data.data || !Array.isArray(data.data)) {
        embeddingModelsCacheFetch = null;
        return data;
      }

      const orderMap = new Map(
        allowedEmbeddingModels.map((id, index) => [id, index]),
      );
      data.data = data.data
        .filter((model) => orderMap.has(model.id))
        .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

      embeddingModelsCache = { data, timestamp: now };
      embeddingModelsCacheFetch = null;

      return data;
    } catch (error) {
      embeddingModelsCacheFetch = null;
      throw error;
    }
  })();

  return embeddingModelsCacheFetch;
}

export async function fetchImageModels(): Promise<OpenRouterModelsResponse> {
  const now = Date.now();

  if (imageModelsCache && now - imageModelsCache.timestamp < CACHE_TTL) {
    return imageModelsCache.data;
  }

  if (imageModelsCacheFetch) {
    return imageModelsCacheFetch;
  }

  imageModelsCacheFetch = (async () => {
    try {
      const response = await fetch(`${env.OPENAI_API_URL}/v1/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          ...openRouterHeaders,
        },
      });

      const data = (await response.json()) as OpenRouterModelsResponse;

      if (!response.ok || !data.data || !Array.isArray(data.data)) {
        imageModelsCacheFetch = null;
        return data;
      }

      const orderMap = new Map(
        allowedImageModels.map((id, index) => [id, index]),
      );
      data.data = data.data
        .filter((model) => orderMap.has(model.id))
        .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

      imageModelsCache = { data, timestamp: now };
      imageModelsCacheFetch = null;

      return data;
    } catch (error) {
      imageModelsCacheFetch = null;
      throw error;
    }
  })();

  return imageModelsCacheFetch;
}

type AllModelsResponse = {
  languageModels: OpenRouterModel[];
  imageModels: OpenRouterModel[];
  embeddingModels: OpenRouterModel[];
  imageModels: OpenRouterModel[];
};

export async function fetchAllModels(): Promise<AllModelsResponse> {
  const [languageModelsResponse, embeddingModelsResponse, imageModelsResponse] =
    await Promise.all([
      fetchLanguageModels(),
      fetchEmbeddingModels(),
      fetchImageModels(),
    ]);

  return {
    languageModels: languageModelsResponse.data,
    imageModels: imageModelsResponse.data,
    embeddingModels: embeddingModelsResponse.data,
    imageModels: imageModelsResponse.data,
  };
}
