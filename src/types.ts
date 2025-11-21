import type { apiKeys, requestLogs, users } from "./db/schema";

export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;
export type DashboardRequestLog = Pick<
  RequestLog,
  "id" | "model" | "totalTokens" | "timestamp" | "duration" | "ip"
>;
export type DashboardApiKey = Pick<
  ApiKey,
  "id" | "name" | "createdAt" | "revokedAt"
> & {
  keyPreview: string;
};

export type Stats = {
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
};

export type AppVariables = {
  user: User;
  apiKey: ApiKey;
};
