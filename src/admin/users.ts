import type postgres from "postgres";

import { policyAppliesTo } from "../billing/policies";
import type { Tables } from "../db-types";
import { recordAdminAction } from "./audit";

type Sql = postgres.Sql;

export type AdminUserRow = {
  id: string;
  slackId: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  isBanned: boolean;
  isAdmin: boolean;
  isIdvVerified: boolean;
  createdAt: Date;
};

export type AppliedPolicy = {
  id: string;
  kind: "funding" | "limit";
  name: string;
  cadence: string;
  amountUsd: string;
  global: boolean;
  enabled: boolean;
  /** The current window's use, when one has been opened. */
  usedUsd: string | null;
  windowAmountUsd: string | null;
};

export type AdminUserDetail = AdminUserRow & {
  billingAccountId: string;
  activeKeys: number;
  policies: AppliedPolicy[];
  abuseEvents: { occurredAt: Date; kind: string; rule: string; enforced: boolean; endpoint: string }[];
  history: { createdAt: Date; action: string; reason: string | null; actor: string | null }[];
};

export class AdminUserError extends Error {}

type UserRow = Pick<
  Tables["users"],
  "id" | "slack_id" | "name" | "email" | "avatar" | "is_banned" | "is_admin" | "is_idv_verified" | "created_at"
>;

const toRow = (row: UserRow): AdminUserRow => ({
  id: row.id,
  slackId: row.slack_id,
  name: row.name,
  email: row.email,
  avatar: row.avatar,
  isBanned: row.is_banned,
  isAdmin: row.is_admin,
  isIdvVerified: row.is_idv_verified,
  createdAt: row.created_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

export class AdminUsers {
  constructor(private readonly sql: Sql) {}

  /**
   * Users matching a name, email, Slack id, user id or API key prefix;
   * the newest users when the query is empty.
   */
  async search(query: string, limit = 50): Promise<AdminUserRow[]> {
    const term = query.trim();
    const columns = this.sql`id, slack_id, name, email, avatar, is_banned, is_admin, is_idv_verified, created_at`;
    if (!term) {
      const rows = await this.sql<UserRow[]>`SELECT ${columns} FROM users ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.map(toRow);
    }
    const like = `%${escapeLike(term)}%`;
    const rows = await this.sql<UserRow[]>`
      SELECT ${columns}
      FROM users
      WHERE
        ${UUID.test(term) ? this.sql`id = ${term}::uuid OR` : this.sql``}
        slack_id = ${term}
        OR name ILIKE ${like}
        OR email ILIKE ${like}
        OR id IN (SELECT user_id FROM api_keys WHERE key_prefix = ${term})
      ORDER BY is_banned, created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toRow);
  }

  async detail(userId: string): Promise<AdminUserDetail | null> {
    if (!UUID.test(userId)) return null;
    const [row] = await this.sql<(UserRow & { billing_account_id: string; active_keys: number })[]>`
      SELECT
        app_user.id, app_user.slack_id, app_user.name, app_user.email, app_user.avatar,
        app_user.is_banned, app_user.is_admin, app_user.is_idv_verified, app_user.created_at,
        account.id AS billing_account_id,
        (SELECT count(*)::int FROM api_keys WHERE user_id = app_user.id AND revoked_at IS NULL) AS active_keys
      FROM users AS app_user
      JOIN billing_accounts AS account ON account.owner_type = 'user' AND account.owner_id = app_user.id
      WHERE app_user.id = ${userId}::uuid
    `;
    if (!row) return null;
    const accountId = row.billing_account_id;

    const [funding, limits, abuse, history] = await Promise.all([
      this.sql<PolicyWindowRow[]>`
        SELECT
          policy.id, policy.name, policy.cadence, policy.amount_usd::text AS amount, policy.account_id IS NULL AS global, policy.enabled,
          (period.reserved_usd + period.committed_usd)::text AS used, period.granted_usd::text AS window_amount
        FROM billing_funding_policies AS policy
        LEFT JOIN billing_funding_windows AS period
          ON period.policy_id = policy.id AND period.account_id = ${accountId}::uuid AND period.generation = policy.generation
            AND period.superseded_at IS NULL AND period.window_start <= now() AND period.window_end > now()
        WHERE ${policyAppliesTo(this.sql, "funding", accountId)}
          AND (policy.effective_until IS NULL OR policy.effective_until > now())
        ORDER BY policy.priority, policy.created_at
      `,
      this.sql<PolicyWindowRow[]>`
        SELECT
          policy.id, policy.name, policy.cadence, policy.limit_usd::text AS amount, policy.account_id IS NULL AS global, policy.enabled,
          (period.reserved_usd + period.committed_usd)::text AS used, period.limit_usd::text AS window_amount
        FROM billing_limit_policies AS policy
        LEFT JOIN billing_limit_windows AS period
          ON period.policy_id = policy.id AND period.account_id = ${accountId}::uuid AND period.generation = policy.generation
            AND period.superseded_at IS NULL AND period.window_start <= now() AND period.window_end > now()
        WHERE ${policyAppliesTo(this.sql, "limit", accountId)}
          AND (policy.effective_until IS NULL OR policy.effective_until > now())
        ORDER BY policy.created_at
      `,
      this.sql<Pick<Tables["abuse_events"], "occurred_at" | "kind" | "rule" | "enforced" | "endpoint">[]>`
        SELECT occurred_at, kind, rule, enforced, endpoint
        FROM abuse_events
        WHERE user_id = ${userId}::uuid
        ORDER BY occurred_at DESC
        LIMIT 20
      `,
      this.sql<{ created_at: Date; action: string; reason: string | null; actor: string | null }[]>`
        SELECT event.created_at, event.action, event.reason, actor.name AS actor
        FROM admin_audit_events AS event
        LEFT JOIN users AS actor ON actor.id = event.actor_user_id
        WHERE event.target_type = 'user' AND event.target_id = ${userId}
        ORDER BY event.created_at DESC
        LIMIT 20
      `,
    ]);

    return {
      ...toRow(row),
      billingAccountId: accountId,
      activeKeys: row.active_keys,
      policies: [
        ...funding.map((policy) => toAppliedPolicy("funding", policy)),
        ...limits.map((policy) => toAppliedPolicy("limit", policy)),
      ],
      abuseEvents: abuse.map((event) => ({
        occurredAt: event.occurred_at,
        kind: event.kind,
        rule: event.rule,
        enforced: event.enforced,
        endpoint: event.endpoint,
      })),
      history: history.map((event) => ({
        createdAt: event.created_at,
        action: event.action,
        reason: event.reason,
        actor: event.actor,
      })),
    };
  }

  /** Bans take effect on the next request: keys and sessions check the flag every time. */
  async setBanned(actorUserId: string, userId: string, banned: boolean, reason: string | null): Promise<void> {
    if (!UUID.test(userId)) throw new AdminUserError("User not found");
    if (banned && actorUserId === userId) throw new AdminUserError("You cannot ban yourself");
    await this.sql.begin(async (tx) => {
      const [user] = await tx<{ is_banned: boolean }[]>`
        SELECT is_banned FROM users WHERE id = ${userId}::uuid FOR UPDATE
      `;
      if (!user) throw new AdminUserError("User not found");
      if (user.is_banned === banned) return;
      await tx`UPDATE users SET is_banned = ${banned}, updated_at = now() WHERE id = ${userId}::uuid`;
      await recordAdminAction(tx, {
        actorUserId,
        action: banned ? "user_banned" : "user_unbanned",
        targetType: "user",
        targetId: userId,
        reason,
      });
    });
  }
}

type PolicyWindowRow = {
  id: string;
  name: string;
  cadence: string;
  amount: string;
  global: boolean;
  enabled: boolean;
  used: string | null;
  window_amount: string | null;
};

const toAppliedPolicy = (kind: "funding" | "limit", row: PolicyWindowRow): AppliedPolicy => ({
  id: row.id,
  kind,
  name: row.name,
  cadence: row.cadence,
  amountUsd: row.amount,
  global: row.global,
  enabled: row.enabled,
  usedUsd: row.used,
  windowAmountUsd: row.window_amount,
});
