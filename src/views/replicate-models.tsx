import type { ReplicateCategory, ReplicateModel } from "../lib/replicate";
import type { User } from "../types";
import { Header } from "./components/Header";
import { Layout } from "./layout";

type ReplicateModelsProps = {
  user: User;
  categories: ReplicateCategory[];
};

export const ReplicateModels = ({ user, categories }: ReplicateModelsProps) => {
  return (
    <Layout title="Replicate Models" includeAlpine user={user}>
      <Header title="hackai" user={user} />
      <div class="w-full max-w-6xl mx-auto px-4 py-8">
        <div class="flex items-center gap-3 mb-2">
          <h1 class="text-4xl font-bold text-brand-heading">
            Replicate Models
          </h1>
          <span class="px-3 py-1 rounded-full text-xs font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20">
            Beta
          </span>
        </div>
        <p class="text-lg mb-4">
          Run AI models via Replicate's predictions API.{" "}
          <a
            href="https://docs.ai.hackclub.com/guide/replicate.html"
            class="text-brand-primary font-bold"
          >
            View the docs...
          </a>
        </p>
        <hr class="border-brand-border mb-8" />

        {categories.map((category) => (
          <CategorySection category={category} />
        ))}
      </div>
    </Layout>
  );
};

const CategorySection = ({ category }: { category: ReplicateCategory }) => {
  if (category.models.length === 0) return null;

  return (
    <div class="mb-12">
      <h2 class="text-2xl font-bold text-brand-heading mb-6">
        {category.name}
      </h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {category.models.map((model) => (
          <ModelCard model={model} />
        ))}
      </div>
    </div>
  );
};

const ModelCard = ({ model }: { model: ReplicateModel }) => {
  const modelId = `${model.owner}/${model.name}`;
  const description = model.description || "";
  const truncatedDescription =
    description.length > 120 ? `${description.slice(0, 120)}...` : description;

  return (
    <a
      href={`https://replicate.com/${modelId}`}
      target="_blank"
      rel="noopener noreferrer"
      class="block bg-brand-surface border-2 border-brand-border rounded-xl overflow-hidden h-full flex flex-col hover:border-brand-primary/50 hover:shadow-md transition-all"
    >
      <div class="h-48 bg-brand-bg">
        {model.cover_image_url ? (
          <img
            src={model.cover_image_url}
            alt={model.name}
            class="w-full h-full object-cover"
          />
        ) : (
          <div class="w-full h-full flex items-center justify-center text-brand-text/30">
            <svg
              class="w-12 h-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
        )}
      </div>
      <div class="p-4 flex flex-col gap-2 flex-1">
        <div class="flex items-center gap-1">
          <span class="text-brand-text/60">{model.owner}</span>
          <span class="text-brand-text/40">/</span>
          <span class="font-bold text-brand-heading">{model.name}</span>
        </div>
        {truncatedDescription && (
          <p class="text-sm text-brand-text line-clamp-2">
            {truncatedDescription}
          </p>
        )}
      </div>
    </a>
  );
};
