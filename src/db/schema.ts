import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const reviewStatusEnum = pgEnum("review_status", [
  "normal",
  "flagged",
  "strict",
  "banned",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slackId: text("slack_id").notNull().unique(),

    email: text("email"),
    name: text("name"),
    avatar: text("avatar"),
    spendingLimitUsd: numeric("spending_limit_usd", {
      precision: 10,
      scale: 8,
    }).default("4"),
    openrouterKey: text("openrouter_key"),
    openrouterKeyHash: text("openrouter_key_hash"),
    openrouterKeyLimit: numeric("openrouter_key_limit", {
      precision: 10,
      scale: 8,
    }),
    isIdvVerified: boolean("is_idv_verified").notNull().default(false),
    skipIdv: boolean("skip_idv").notNull().default(false),
    isAdmin: boolean("is_admin").notNull().default(false),
    agentBannerDismissedAt: timestamp("agent_banner_dismissed_at"),
    reviewStatus: reviewStatusEnum("review_status").notNull().default("normal"),
    violationCountWeek: integer("violation_count_week").notNull().default(0),
    violationCountMonth: integer("violation_count_month").notNull().default(0),
    lastViolationAt: timestamp("last_violation_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("users_slack_id_idx").on(table.slackId),
    index("users_email_idx").on(table.email),
    index("users_idv_verified_idx").on(table.isIdvVerified),
    index("users_review_status_idx").on(table.reviewStatus),
    index("users_is_admin_idx").on(table.isAdmin),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    isUnlimited: boolean("is_unlimited").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    index("api_keys_user_id_idx").on(table.userId),
    index("api_keys_key_revoked_idx").on(table.key, table.revokedAt),
  ],
);

export const requestLogs = pgTable(
  "request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slackId: text("slack_id").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    request: jsonb("request").notNull(),
    response: jsonb("response").notNull(),
    headers: jsonb("headers"),
    ip: text("ip").notNull(),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
    duration: integer("duration").notNull(),
    cost: numeric("cost", { precision: 10, scale: 8 }).notNull().default("0"),
  },
  (table) => [
    index("request_logs_user_timestamp_cost_idx").on(
      table.userId,
      table.timestamp.desc(),
      table.cost,
    ),
    index("request_logs_apikey_timestamp_idx").on(
      table.apiKeyId,
      table.timestamp.desc(),
    ),
    index("request_logs_slack_timestamp_idx").on(
      table.slackId,
      table.timestamp.desc(),
    ),
    index("request_logs_model_idx").on(table.model),
    index("request_logs_user_id_idx").on(table.userId),
    // We got 35GB (!!!) of index storage with just 308MB of actual data.
    // We also barely ever need to actually query based off the JSON itself - usually a text search is fine.
    // index("request_logs_request_gin_idx").using("gin", table.request),
    // index("request_logs_response_gin_idx").using("gin", table.response),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const contentViolations = pgTable(
  "content_violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    violationEventId: uuid("violation_event_id").notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestLogId: uuid("request_log_id").references(() => requestLogs.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(), // "input" or "output"
    category: text("category").notNull(), // "illicit", "violence", etc.
    content: text("content"), // actual flagged content
    contentHash: text("content_hash"), // hash of flagged content
    dismissed: boolean("dismissed").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("violations_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
    index("violations_request_log_idx").on(table.requestLogId),
    index("violations_event_id_idx").on(table.violationEventId),
  ],
);

export const userFlagSettings = pgTable(
  "user_flag_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    optInForcedReview: boolean("opt_in_forced_review").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("flag_settings_user_idx").on(table.userId)],
);

export const pendingCharges = pgTable(
  "pending_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    estimatedCost: numeric("estimated_cost", {
      precision: 10,
      scale: 8,
    }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("pending_charges_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
);

export type Violation = typeof contentViolations.$inferSelect;
