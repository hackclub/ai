import type { users, apiKeys, requestLogs } from "./db/schema";

export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;

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
