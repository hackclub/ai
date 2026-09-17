import type { Backend } from "../../server";
import { type CatalogModel, modelTypeOf } from "#lib/format.ts";

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
