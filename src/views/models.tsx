import type { OpenRouterModel } from "../lib/models";
import type { User } from "../types";
import { Header } from "./components/Header";
import { Check, ChevronDown, Copy } from "./components/Icons";
import { Layout } from "./layout";

type ModelsProps = {
  user: User;
  languageModels: OpenRouterModel[];
  imageModels: OpenRouterModel[];
  embeddingModels: OpenRouterModel[];
};

export const Models = ({
  user,
  languageModels,
  imageModels,
  embeddingModels,
}: ModelsProps) => {
  return (
    <Layout title="Models" includeAlpine>
      <Header title="hackai" user={user} showGlobalStats />
      <div class="w-full max-w-6xl mx-auto px-4 py-8">
        <h1 class="text-3xl font-bold mb-8 text-brand-heading">
          Available Models
        </h1>
        <ModelsList title="Language Models" models={languageModels} />
        <ModelsList title="Image Models" models={imageModels} />
        <ModelsList title="Embedding Models" models={embeddingModels} />
      </div>
    </Layout>
  );
};

const ModelsList = ({
  title,
  models,
}: {
  title: string;
  models: OpenRouterModel[];
}) => {
  return (
    <div class="mb-12" x-data="{ expanded: window.innerWidth >= 1024 }">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-brand-heading">{title}</h2>
        {models.length > 3 && (
          <button
            type="button"
            x-on:click="expanded = !expanded"
            class="text-sm font-medium text-brand-primary hover:text-brand-primary-hover transition-colors flex items-center gap-1"
            title={`expanded ? 'Show less' : 'Show all ${models.length}'`}
          >
            <span
              x-text={`expanded ? 'Show less' : 'Show all ${models.length}'`}
            />
            <ChevronDown
              class="w-4 h-4 transition-transform"
              x-bind:class="expanded ? 'rotate-180' : ''"
            />
          </button>
        )}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {models.map((model, index) => (
          <div
            x-show={index < 3 ? "true" : "expanded"}
            x-transition:enter="transition ease-out duration-200"
            x-transition:enter-start="opacity-0 -translate-y-2"
            x-transition:enter-end="opacity-100 translate-y-0"
          >
            <ModelCard model={model} />
          </div>
        ))}
      </div>
    </div>
  );
};

const stripMarkdownLinks = (text: string) =>
  text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

const ModelCard = ({ model }: { model: OpenRouterModel }) => {
  const displayName = model.name || model.id;
  const rawDescription = model.description || "";
  const description = stripMarkdownLinks(rawDescription);
  const truncatedDescription =
    description.length > 250 ? `${description.slice(0, 250)}...` : description;

  return (
    <a
      href={`/models/${model.id}`}
      class="block bg-brand-surface border-2 border-brand-border p-4 rounded-xl h-full flex flex-col hover:border-brand-primary/50 hover:shadow-md transition-all"
      x-data="{ copied: false }"
    >
      <div class="flex flex-col gap-2 flex-1">
        <div class="flex items-start justify-between gap-4 flex-1">
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-brand-heading text-base truncate">
              {displayName}
            </h3>
            {truncatedDescription && (
              <p class="text-sm text-brand-text mt-1 line-clamp-2 sm:line-clamp-3">
                {truncatedDescription}
              </p>
            )}
          </div>
        </div>
        <div class="flex items-center gap-2 mt-auto">
          <button
            type="button"
            {...{
              "x-on:click.stop.prevent": `navigator.clipboard.writeText('${model.id}'); copied = true; setTimeout(() => copied = false, 2000)`,
            }}
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-transparent border border-brand-border hover:border-brand-primary/50 transition-colors cursor-pointer group"
            title="Click to copy model ID"
          >
            <code class="text-xs font-mono text-brand-primary">{model.id}</code>
            <span x-show="!copied">
              <Copy class="w-3.5 h-3.5 text-brand-text/50 group-hover:text-brand-primary transition-colors" />
            </span>
            <span x-show="copied" x-cloak>
              <Check class="w-3.5 h-3.5 text-green-500" />
            </span>
          </button>
        </div>
      </div>
    </a>
  );
};
