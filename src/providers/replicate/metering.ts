import { type CapturedBody, meterStreamed, type UsageVerdict } from "../metered-body";
import type { MeteredProviderResponse } from "../types";
import { predictionCharge } from "./billing";
import {
  isTerminal,
  parsePrediction,
  type PredictionSnapshot,
  type TerminalPrediction,
} from "./predictions";
import type { ReplicatePricing } from "./pricing";

const POLL_DELAYS_MS = [1_000, 2_000, 3_000, 5_000];
const MAX_CONSECUTIVE_LOOKUP_FAILURES = 5;

export type PredictionSettlement = {
  pricing: ReplicatePricing;
  /** Fetches the current state of a prediction by id. */
  lookup: (id: string) => Promise<PredictionSnapshot | null>;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Waits until a prediction reaches a terminal status. A `Prefer: wait`
 * response is usually terminal already; otherwise the prediction is polled
 * with a gentle backoff until the deadline passes.
 */
const awaitTerminal = async (
  initial: PredictionSnapshot,
  settlement: PredictionSettlement,
): Promise<TerminalPrediction | null> => {
  if (isTerminal(initial)) return initial;
  if (!initial.id) return null;
  const sleep = settlement.sleep ?? Bun.sleep;
  const deadline = Date.now() + settlement.timeoutMs;
  let consecutiveFailures = 0;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    await sleep(POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]);
    let latest: PredictionSnapshot | null;
    try {
      latest = await settlement.lookup(initial.id);
      consecutiveFailures = 0;
    } catch (error) {
      // A transient upstream error is retried; a run of them is given up on
      // so a dead upstream still resolves within the settlement window.
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_LOOKUP_FAILURES) throw error;
      continue;
    }
    if (isTerminal(latest)) return latest;
  }
  return null;
};

const isSuccess = (status: number) => status >= 200 && status < 300;

// The prediction id is kept on every outcome without usage, so
// reconciliation can look the prediction up later instead of releasing the
// hold unbilled.
const withoutUsage = (reason: string, predictionId: string | null = null): UsageVerdict => ({
  usage: null,
  providerRequestId: predictionId,
  reason,
});

/** Follows a fully read prediction response to a terminal status and bills its metrics. */
const settlePrediction = async (
  body: CapturedBody,
  settlement: PredictionSettlement,
): Promise<UsageVerdict> => {
  if (!isSuccess(body.status)) return withoutUsage(`Replicate returned HTTP ${body.status}`);
  const initial = parsePrediction(body.text);
  if (!initial) return withoutUsage("Replicate response was not a prediction object");
  const predictionId = initial.id ?? null;
  let final: TerminalPrediction | null;
  try {
    final = await awaitTerminal(initial, settlement);
  } catch (error) {
    return withoutUsage(error instanceof Error ? error.message : "Prediction lookup failed", predictionId);
  }
  if (!final) {
    return withoutUsage(
      `Prediction ${predictionId ?? "?"} did not finish within the settlement window`,
      predictionId,
    );
  }
  const finalId = final.id ?? predictionId;
  const charge = predictionCharge(final, settlement.pricing);
  // A run that cannot be billed from the response yet is held for
  // reconciliation rather than closed at $0 as if Replicate had reported
  // nothing to charge.
  if (charge.state === "not_ready") {
    return withoutUsage(`Prediction ${predictionId ?? "?"} ${charge.detail}`, finalId);
  }
  return {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: charge.costUsd },
    providerRequestId: finalId,
  };
};

/**
 * Wraps a Replicate prediction response for the metered lifecycle. The body
 * streams to the client untouched; once it has been read, the prediction is
 * followed to a terminal status and billed from its reported metrics. Failed
 * and cancelled predictions still bill any hardware time Replicate reports.
 * Anything that prevents reading final metrics resolves without usage so the
 * reservation is held for reconciliation instead of being guessed.
 */
export const meterPrediction = (
  upstream: Response,
  requestBody: string,
  settlement: PredictionSettlement,
): MeteredProviderResponse =>
  meterStreamed(upstream, {
    requestBody,
    reader: {
      read: (body) => {
        const { end } = body;
        switch (end.kind) {
          case "done":
            return settlePrediction(body, settlement);
          case "error":
            return withoutUsage(end.error instanceof Error ? end.error.message : "Response stream failed");
          case "cancelled":
            // Replicate creates the prediction before responding, so a
            // cancelled read still names a run that may be billed; keep its
            // id for reconciliation, exactly as a finished read does.
            return withoutUsage(
              typeof end.reason === "string" ? end.reason : "Client cancelled response",
              isSuccess(body.status) ? (parsePrediction(body.text)?.id ?? null) : null,
            );
        }
      },
    },
    // A prediction is one JSON document, parsed whole.
    maxCapturedBytes: null,
    headers: "upstream",
    onCancel: { kind: "cancel-upstream" },
  });
