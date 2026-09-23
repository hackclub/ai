import { error, redirect } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

import { modelTypeOf } from "#lib/format.ts";
import { modelExamples } from "#lib/server/examples.ts";
import { requireUser } from "#lib/server/page.ts";

export const load: PageServerLoad = async ({ locals, params }) => {
  requireUser(locals);
  const modelId = params.id;
  if (!modelId) redirect(302, "/dashboard");

  const model = await locals.dashboard.model(modelId);
  if (!model) error(404, `The model ${modelId} was not found or is not available.`);

  const modelType = modelTypeOf(model);
  return {
    model,
    modelType,
    examples: await modelExamples(locals.dashboard.site.baseUrl, model.id, modelType),
  };
};
