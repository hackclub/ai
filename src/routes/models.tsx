import * as Sentry from "@sentry/bun";
import { Hono } from "hono";
import { fetchAllModels, type OpenRouterModel } from "../lib/models";
import { requireAuth } from "../middleware/auth";
import type { AppVariables, ModelType } from "../types";
import { Header } from "../views/components/Header";
import { Layout } from "../views/layout";
import { ModelPage } from "../views/model";
import { Models } from "../views/models";

const models = new Hono<{ Variables: AppVariables }>();

function getModelType(model: OpenRouterModel): ModelType {
  const modality = model.architecture?.modality || "";
  const outputModalities = model.architecture?.output_modalities || [];

  if (
    modality === "text->embeddings" ||
    outputModalities.includes("embeddings")
  ) {
    return "embedding";
  }

  if (outputModalities.includes("image")) {
    return "image";
  }

  return "language";
}

models.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const { languageModels, imageModels, embeddingModels } =
    await Sentry.startSpan({ name: "fetch.models" }, async () => {
      try {
        return await fetchAllModels();
      } catch {
        return { languageModels: [], imageModels: [], embeddingModels: [] };
      }
    });

  return c.html(
    <Models
      user={user}
      languageModels={languageModels}
      imageModels={imageModels}
      embeddingModels={embeddingModels}
    />,
  );
});

models.get("/*", requireAuth, async (c) => {
  const user = c.get("user");

  // Extract the full model ID from the path (handles slashes like qwen/qwen3-32b)
  const modelId = c.req.path.replace(/^\/models\//, "");

  if (!modelId) {
    return c.redirect("/dashboard");
  }

  const { languageModels, imageModels, embeddingModels } =
    await Sentry.startSpan({ name: "fetch.models" }, async () => {
      try {
        return await fetchAllModels();
      } catch {
        return { languageModels: [], imageModels: [], embeddingModels: [] };
      }
    });

  // Find the model in any of the arrays
  const allModels = [...languageModels, ...imageModels, ...embeddingModels];
  const model = allModels.find((m) => m.id === modelId);

  if (!model) {
    return c.html(
      <Layout title="Model Not Found" includeAlpine>
        <Header title="hackai" user={user} showGlobalStats />
        <div class="w-full max-w-6xl mx-auto px-4 py-8">
          <div class="bg-white border-2 border-brand-border rounded-2xl p-8 text-center">
            <h1 class="text-2xl font-bold text-brand-heading mb-4">
              Model Not Found
            </h1>
            <p class="text-brand-text mb-6">
              The model{" "}
              <code class="bg-brand-bg px-2 py-1 rounded text-brand-primary">
                {modelId}
              </code>{" "}
              was not found or is not available.
            </p>
            <a
              href="/dashboard"
              class="inline-block px-6 py-2.5 text-sm font-medium rounded-full bg-brand-primary text-white hover:bg-brand-primary-hover transition-all"
            >
              Back to Dashboard
            </a>
          </div>
        </div>
      </Layout>,
    );
  }

  // Always detect model type from architecture
  const modelType = getModelType(model);

  return c.html(<ModelPage model={model} modelType={modelType} user={user} />);
});

export default models;
