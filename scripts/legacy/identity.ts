import type postgres from "postgres";

import { hashApiKey } from "../../src/auth/api-keys";

type Sql = postgres.Sql;

/**
 * Copies users and API keys from the previous gateway's database (`~/ai`,
 * Drizzle schema) into this one. Safe to re-run: rows keep their legacy ids
 * and are upserted, so a rehearsal followed by a cutover run converges.
 *
 * - Every user gets a billing account and a daily allowance equal to their
 *   legacy `spending_limit_usd` (the legacy limit was per UTC day).
 * - Keys were stored in plaintext; only their SHA-256 digest is written, which
 *   is what `authenticateApiKey` looks up, so existing keys keep working.
 * - The legacy schema allowed several users per Slack ID; this one does not.
 *   The most recently active one is kept and the others' keys move to it.
 * - Sessions are not copied: the session cookie is now `__Host-` prefixed,
 *   so legacy cookies could never match.
 */
export type IdentityImportSummary = {
  users: number;
  mergedUsers: number;
  apiKeys: number;
  createdPolicies: number;
};

type LegacyUser = {
  id: string;
  slack_id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  is_banned: boolean;
  is_idv_verified: boolean;
  skip_idv: boolean;
  spending_limit_usd: string | null;
  created_at: Date;
  updated_at: Date;
  agent_banner_dismissed_at: Date | null;
  last_request_at: Date | null;
};

type LegacyKey = {
  id: string;
  user_id: string;
  key: string;
  name: string;
  created_at: Date;
  revoked_at: Date | null;
};

const BATCH = 1000;
const DEFAULT_DAILY_ALLOWANCE_USD = "3";

const chunks = <T>(rows: T[]) =>
  Array.from({ length: Math.ceil(rows.length / BATCH) }, (_, i) => rows.slice(i * BATCH, (i + 1) * BATCH));

/** api_keys.name must be 1–100 characters. */
const keyName = (name: string) => name.trim().slice(0, 100) || "Imported key";

/** Most recent request first, then the oldest account. */
const preferred = (a: LegacyUser, b: LegacyUser) =>
  (b.last_request_at?.getTime() ?? -Infinity) - (a.last_request_at?.getTime() ?? -Infinity) ||
  a.created_at.getTime() - b.created_at.getTime();

/**
 * `legacy` must use TimeZone=UTC: legacy timestamps are `timestamp without
 * time zone` holding UTC, and are converted with `AT TIME ZONE 'UTC'`.
 */
export async function importIdentity(legacy: Sql, target: Sql): Promise<IdentityImportSummary> {
  const legacyUsers = await legacy<LegacyUser[]>`
    SELECT
      u.id, u.slack_id, u.email, u.name, u.avatar,
      u.is_banned, u.is_idv_verified, u.skip_idv,
      u.spending_limit_usd::text AS spending_limit_usd,
      u.created_at AT TIME ZONE 'UTC' AS created_at,
      u.updated_at AT TIME ZONE 'UTC' AS updated_at,
      u.agent_banner_dismissed_at AT TIME ZONE 'UTC' AS agent_banner_dismissed_at,
      CASE WHEN count(*) OVER (PARTITION BY u.slack_id) > 1 THEN (
        SELECT max(r.timestamp) AT TIME ZONE 'UTC' FROM request_logs r WHERE r.user_id = u.id
      ) END AS last_request_at
    FROM users u
  `;
  const legacyKeys = await legacy<LegacyKey[]>`
    SELECT
      id, user_id, key, name,
      created_at AT TIME ZONE 'UTC' AS created_at,
      revoked_at AT TIME ZONE 'UTC' AS revoked_at
    FROM api_keys
  `;

  const bySlackId = Map.groupBy(legacyUsers, (user) => user.slack_id);
  const canonicalOf = new Map<string, string>();
  const users = [...bySlackId.values()].map((group) => {
    const [kept, ...merged] = group.toSorted(preferred);
    if (!kept) throw new Error("empty Slack ID group");
    for (const user of group) canonicalOf.set(user.id, kept.id);
    // A ban on any merged account carries over.
    return { ...kept, is_banned: kept.is_banned || merged.some((user) => user.is_banned) };
  });

  return target.begin(async (tx) => {
    for (const batch of chunks(users)) {
      await tx`
        INSERT INTO users ${tx(
          batch.map((u) => ({
            id: u.id,
            slack_id: u.slack_id,
            email: u.email,
            name: u.name,
            avatar: u.avatar,
            is_banned: u.is_banned,
            is_idv_verified: u.is_idv_verified,
            skip_idv: u.skip_idv,
            created_at: u.created_at,
            updated_at: u.updated_at,
            agent_banner_dismissed_at: u.agent_banner_dismissed_at,
          })),
        )}
        ON CONFLICT (id) DO UPDATE SET
          email = excluded.email,
          name = excluded.name,
          avatar = excluded.avatar,
          is_banned = excluded.is_banned,
          is_idv_verified = excluded.is_idv_verified,
          skip_idv = excluded.skip_idv,
          updated_at = excluded.updated_at,
          agent_banner_dismissed_at = excluded.agent_banner_dismissed_at
      `;
      await tx`
        INSERT INTO billing_accounts ${tx(batch.map((u) => ({ owner_type: "user", owner_id: u.id, created_at: u.created_at })))}
        ON CONFLICT (owner_type, owner_id) DO NOTHING
      `;
    }

    // Accounts that already have a funding policy (from an earlier run, or an
    // admin change made since) keep it.
    const unfunded = await tx<{ account_id: string; owner_id: string }[]>`
      SELECT a.id AS account_id, a.owner_id
      FROM billing_accounts a
      WHERE a.owner_type = 'user'
        AND NOT EXISTS (SELECT 1 FROM billing_funding_policies p WHERE p.account_id = a.id)
    `;
    const allowance = new Map(users.map((u) => [u.id, u.spending_limit_usd ?? DEFAULT_DAILY_ALLOWANCE_USD]));
    const policies = unfunded
      .filter((row) => allowance.has(row.owner_id))
      .map((row) => ({
        account_id: row.account_id,
        name: "Daily allowance",
        cadence: "day",
        amount_usd: allowance.get(row.owner_id),
        priority: 100,
      }));
    for (const batch of chunks(policies)) {
      await tx`INSERT INTO billing_funding_policies ${tx(batch)}`;
    }

    for (const batch of chunks(legacyKeys)) {
      await tx`
        INSERT INTO api_keys ${tx(
          batch.map((k) => {
            const userId = canonicalOf.get(k.user_id);
            if (!userId) throw new Error(`API key ${k.id} belongs to unknown user ${k.user_id}`);
            return {
              id: k.id,
              user_id: userId,
              key_hash: hashApiKey(k.key),
              key_prefix: k.key.slice(0, 16),
              name: keyName(k.name),
              created_at: k.created_at,
              revoked_at: k.revoked_at,
            };
          }),
        )}
        ON CONFLICT (id) DO UPDATE SET
          user_id = excluded.user_id,
          name = excluded.name,
          -- A key revoked on this side stays revoked.
          revoked_at = COALESCE(api_keys.revoked_at, excluded.revoked_at)
      `;
    }

    return {
      users: users.length,
      mergedUsers: legacyUsers.length - users.length,
      apiKeys: legacyKeys.length,
      createdPolicies: policies.length,
    };
  });
}
