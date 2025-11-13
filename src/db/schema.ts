import { pgTable, text, timestamp, integer, uuid, index, jsonb, bigint } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  slackId: text('slack_id').notNull().unique(),
  slackTeamId: text('slack_team_id').notNull(),
  email: text('email'),
  name: text('name'),
  avatar: text('avatar'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  slackIdIdx: index('users_slack_id_idx').on(table.slackId),
}));

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  revokedAt: timestamp('revoked_at'),
}, (table) => ({
  keyIdx: index('api_keys_key_idx').on(table.key),
  userIdIdx: index('api_keys_user_id_idx').on(table.userId),
  revokedAtIdx: index('api_keys_revoked_at_idx').on(table.revokedAt),
}));

export const requestLogs = pgTable('request_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiKeyId: uuid('api_key_id').notNull().references(() => apiKeys.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  slackId: text('slack_id').notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  request: jsonb('request').notNull(),
  response: jsonb('response').notNull(),
  ip: text('ip').notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  duration: integer('duration').notNull(),
}, (table) => ({
  apiKeyIdIdx: index('request_logs_api_key_id_idx').on(table.apiKeyId),
  userIdIdx: index('request_logs_user_id_idx').on(table.userId),
  slackIdIdx: index('request_logs_slack_id_idx').on(table.slackId),
  timestampIdx: index('request_logs_timestamp_idx').on(table.timestamp),
  modelIdx: index('request_logs_model_idx').on(table.model),
}));

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index('sessions_token_idx').on(table.token),
  userIdIdx: index('sessions_user_id_idx').on(table.userId),
  expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
}));
