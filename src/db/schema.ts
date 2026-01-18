import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slackId: text("slack_id").notNull().unique(),

    email: text("email"),
    name: text("name"),
    avatar: text("avatar"),
    isIdvVerified: boolean("is_idv_verified").notNull().default(false),
    skipIdv: boolean("skip_idv").notNull().default(false),
    isBanned: boolean("is_banned").notNull().default(false),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("users_slack_id_idx").on(table.slackId),
    index("users_email_idx").on(table.email),
    index("users_idv_verified_idx").on(table.isIdvVerified),
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
  },
  (table) => [
    index("request_logs_user_timestamp_idx").on(
      table.userId,
      table.timestamp.desc(),
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
    // For nightwatch/manual querying.
    // Here, we sacrifice some write performance for read performance, as writes happen after requests are returned to the user,
    // so write perf is not a big deal.
    index("request_logs_request_gin_idx").using("gin", table.request),
    index("request_logs_response_gin_idx").using("gin", table.response),
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

export const premiumAccessRequests = pgTable(
  "premium_access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    status: text("status").notNull().default("pending"),
    referenceCode: text("reference_code").notNull().unique(),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    notes: text("notes"),
  },
  (table) => [
    index("premium_requests_user_idx").on(table.userId),
    index("premium_requests_status_idx").on(table.status),
    index("premium_requests_ref_idx").on(table.referenceCode),
  ],
);

export const premiumModelAccess = pgTable(
  "premium_model_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    grantedBy: text("granted_by").notNull(),
    requestId: uuid("request_id").references(() => premiumAccessRequests.id),
    expiresAt: timestamp("expires_at"),
  },
  (table) => [
    index("premium_access_user_model_idx").on(table.userId, table.modelId),
  ],
);
