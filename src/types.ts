import type { users, apiKeys } from './db/schema';

export type AppVariables = {
  user: typeof users.$inferSelect;
  apiKey: typeof apiKeys.$inferSelect;
};
