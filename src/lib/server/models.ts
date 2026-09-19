import type { Backend } from "../../server";
import { type CatalogModel, type ModelCardData, modelTypeOf, stripMarkdownLinks } from "#lib/format.ts";

export type GroupedModels = {
  languageModels: CatalogModel[];
  imageModels: CatalogModel[];
  embeddingModels: CatalogModel[];
};

/** Catalog models grouped the way the dashboard presents them. */
export async function groupedModels(backend: Backend): Promise<GroupedModels> {
  let language: CatalogModel[] = [];
  let embedding: CatalogModel[] = [];
  try {
    [language, embedding] = await Promise.all([
      backend.catalog.list("language") as Promise<CatalogModel[]>,
      backend.catalog.list("embedding") as Promise<CatalogModel[]>,
    ]);
  } catch {
    // Listing failures render as empty sections rather than a broken page.
  }
  return {
    languageModels: language.filter((model) => modelTypeOf(model) === "language"),
    imageModels: language.filter((model) => modelTypeOf(model) === "image"),
    embeddingModels: [
      ...embedding,
      ...language.filter((model) => modelTypeOf(model) === "embedding"),
    ],
  };
}

const toCard = (model: CatalogModel): ModelCardData => ({
  id: model.id,
  name: model.name,
  // The card clamps to two lines; 240 characters is more than it can show.
  description: stripMarkdownLinks(model.description ?? "").slice(0, 240),
});

export type GroupedModelCards = {
  languageModels: ModelCardData[];
  imageModels: ModelCardData[];
  embeddingModels: ModelCardData[];
};

/** Projection of `groupedModels` carrying only the fields the `/models` cards render. */
export async function groupedModelCards(backend: Backend): Promise<GroupedModelCards> {
  const groups = await groupedModels(backend);
  return {
    languageModels: groups.languageModels.map(toCard),
    imageModels: groups.imageModels.map(toCard),
    embeddingModels: groups.embeddingModels.map(toCard),
  };
}
