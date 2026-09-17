import type { Backend } from "../../server";
import type { SessionUser } from "../../auth/sessions";
import { listApiKeys } from "../../gateway/keys-api";

export type ActivityRow = {
  requestId: string;
  occurredAt: string;
  model: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  billedCostUsd: string;
  durationMs: number;
  error: string | null;
  apiKeyName: string;
  ip: string;
};

export type ActivityPage = {
  rows: ActivityRow[];
  next: { before: string; beforeId: string } | null;
};

const modelNames = async (backend: Backend) => {
  try {
    const [language, embedding] = await Promise.all([
      backend.catalog.list("language"),
      backend.catalog.list("embedding"),
    ]);
    return new Map(
      [...language, ...embedding].map((model) => [model.id, model.name || model.id]),
    );
  } catch {
    return new Map<string, string>();
  }
};

/** Recent requests for the activity page, enriched with key and model names. */
export async function activityPage(
  backend: Backend,
  user: SessionUser,
  before?: { before: string; beforeId: string },
): Promise<ActivityPage> {
  const [page, keys, names] = await Promise.all([
    backend.queries.recentRequests(user.billingAccountId, { before }),
    listApiKeys(backend.sql, user.id),
    modelNames(backend),
  ]);
  const keyNames = new Map(keys.map((key) => [key.id, key.name]));
  return {
    rows: page.requests.map((request) => ({
      requestId: request.requestId,
      occurredAt: request.occurredAt,
      model: request.model,
      modelName: names.get(request.model) ?? request.model,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      billedCostUsd: request.billedCostUsd,
      durationMs: request.durationMs,
      error:
        request.outcome === "completed"
          ? null
          : request.errorCode || request.outcome.replaceAll("_", " "),
      apiKeyName: (request.apiKeyId && keyNames.get(request.apiKeyId)) || "revoked key",
      ip: request.ip,
    })),
    next: page.next,
  };
}
