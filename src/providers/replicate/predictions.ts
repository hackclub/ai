import type { ReplicatePredictionMetrics } from "./pricing";

/** The fields of a Replicate prediction the gateway bills and reconciles from. */
export type PredictionSnapshot = {
  id?: string;
  status?: string;
  /** `owner/name` of the model that ran, as Replicate reports it. */
  model?: string;
  metrics?: ReplicatePredictionMetrics;
};

export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "aborted"]);

export type TerminalPrediction = PredictionSnapshot & { status: string };

export const isTerminal = (
  snapshot: PredictionSnapshot | null,
): snapshot is TerminalPrediction =>
  snapshot?.status !== undefined && TERMINAL_STATUSES.has(snapshot.status);

export const parsePrediction = (body: string): PredictionSnapshot | null => {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PredictionSnapshot)
      : null;
  } catch {
    return null;
  }
};

export type ReplicateConfig = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export type PredictionLookup =
  | { state: "found"; prediction: PredictionSnapshot }
  | { state: "not_found" };

/**
 * `GET /v1/predictions/{id}`. Returns `not_found` for 404 and throws on any
 * other failure, so a transient upstream error is retried rather than
 * treated as a missing prediction.
 */
export async function fetchReplicatePrediction(
  id: string,
  config: ReplicateConfig,
): Promise<PredictionLookup> {
  const fetchImplementation = config.fetch ?? fetch;
  const baseUrl = (config.baseUrl ?? "https://api.replicate.com").replace(/\/$/, "");
  const response = await fetchImplementation(
    `${baseUrl}/v1/predictions/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${config.apiKey}` } },
  );
  if (response.status === 404) return { state: "not_found" };
  if (!response.ok) {
    throw new Error(`Prediction ${id} lookup returned HTTP ${response.status}`);
  }
  const prediction = parsePrediction(await response.text());
  if (!prediction) throw new Error(`Prediction ${id} lookup returned a non-object body`);
  return { state: "found", prediction };
}
