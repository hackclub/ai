import type { Usd } from "../billing/money";

export type NormalizedUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: Usd;
};

export type ProviderCompletion =
  | {
      state: "complete";
      providerRequestId: string | null;
      usage: NormalizedUsage;
      responseBody: string;
      bodyCapture: "complete" | "truncated";
    }
  | {
      state: "uncertain";
      providerRequestId: string | null;
      reason: string;
      responseBody: string;
      bodyCapture: "complete" | "partial" | "truncated";
    }
  | {
      state: "cancelled";
      providerRequestId: string | null;
      reason: string;
      responseBody: string;
      bodyCapture: "partial" | "truncated";
    };

export type MeteredProviderResponse = {
  response: Response;
  requestBody: string;
  completion: Promise<ProviderCompletion>;
};
