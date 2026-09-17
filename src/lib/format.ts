/** Display helpers shared by dashboard pages. Ported from the old gateway. */

export function formatPrice(price: string | number): string {
  const str = String(price).trim();
  const num = Number.parseFloat(str);
  if (!str || Number.isNaN(num)) return "N/A";
  if (num === 0) return "Free";

  const [rawWhole = "0", rawFraction = ""] = str.split(".");
  const whole = rawWhole.replace(/^0+/, "") || "0";
  const fraction = rawFraction
    .slice(0, 6)
    .replace(/0+$/, "")
    .padEnd(2, "0");

  return `$${whole}.${fraction}`;
}

export function formatNumberShort(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return num.toString();
}

export const formatRelativeTime = (timestamp: string | Date, now = Date.now()) => {
  const diff = Math.floor((now - new Date(timestamp).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

export const formatFullTime = (timestamp: string | Date) =>
  new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });

export const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

export const hashColor = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return `oklch(78% 0.16 ${Math.abs(hash) % 360})`;
};

export const displayModelName = (name: string) => name.split(":").at(-1)?.trim() || name;

export const stripMarkdownLinks = (text: string) =>
  text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

/** Per-token price string from OpenRouter shown per million tokens. */
export function formatPerMillion(pricePerToken?: string): string {
  if (!pricePerToken) return "N/A";
  const price = Number.parseFloat(pricePerToken) * 1_000_000;
  if (Number.isNaN(price)) return "N/A";
  if (price === 0) return "Free";
  if (price < 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

export const providerName = (modelId: string) => {
  const [first = ""] = modelId.split("/");
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "Unknown";
};

export type ModelType = "language" | "image" | "embedding";

export type CatalogModel = {
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
  pricing?: { prompt?: string; completion?: string; request?: string };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
};

export const modelTypeOf = (model: CatalogModel): ModelType => {
  const modality = model.architecture?.modality ?? "";
  const outputs = model.architecture?.output_modalities ?? [];
  if (modality === "text->embeddings" || outputs.includes("embeddings")) return "embedding";
  if (outputs.includes("image")) return "image";
  return "language";
};

export const formatModality = (model: CatalogModel) => {
  if (model.architecture?.modality) return model.architecture.modality.replace("->", " → ");
  const inputs = model.architecture?.input_modalities?.join(", ") || "text";
  const outputs = model.architecture?.output_modalities?.join(", ") || "text";
  return `${inputs} → ${outputs}`;
};
