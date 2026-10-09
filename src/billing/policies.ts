import type postgres from "postgres";

import { recordAdminAction } from "../admin/audit";
import type { Tables } from "../db-types";
import { Usd } from "./money";

type Sql = postgres.Sql;

export type PolicyKind = "funding" | "limit";

const TABLES = {
  funding: "billing_funding_policies",
  limit: "billing_limit_policies",
} as const;

/**
 * SQL condition: the policy aliased `policy` applies to the account. An
 * account policy always applies to its own account. A global policy (no
 * account) applies to every account with no enabled, current policy of its
 * own of the same kind, so a per-account allowance replaces the global ones
 * instead of adding to them.
 */
export const policyAppliesTo = (
  sql: Sql | postgres.TransactionSql,
  kind: PolicyKind,
  /** An account id, or a fragment naming an account id column. */
  accountId: string | postgres.PendingQuery<postgres.Row[]>,
) => sql`(
  policy.account_id = ${accountId}::uuid
  OR (
    policy.account_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM ${sql(TABLES[kind])} AS own
      WHERE
        own.account_id = ${accountId}::uuid
        AND own.enabled
        AND own.effective_from <= now()
        AND (own.effective_until IS NULL OR own.effective_until > now())
    )
  )
)`;

const CADENCES = {
  funding: ["day", "week", "month", "year"],
  limit: ["day", "week", "month", "year", "lifetime"],
} as const;

export type GlobalPolicy = {
  id: string;
  kind: PolicyKind;
  name: string;
  cadence: string;
  timezone: string;
  amountUsd: string;
  /** Funding only: lower is spent first. */
  priority: number | null;
  enabled: boolean;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  /** Accounts with a policy of their own of this kind, which this one does not reach. */
  overriddenAccounts: number;
};

export type PolicyInput = {
  name: string;
  cadence: string;
  amountUsd: Usd;
  priority?: number;
  enabled: boolean;
  timezone?: string;
  effectiveUntil?: Date | null;
};

export type PolicyChange = Partial<Pick<PolicyInput, "name" | "amountUsd" | "priority" | "enabled" | "effectiveUntil">>;

export class PolicyError extends Error {}

type PolicyRow = Pick<
  Tables["billing_funding_policies"],
  "id" | "name" | "cadence" | "timezone" | "enabled" | "effective_from" | "effective_until"
> & { amount_usd: string; priority: number | null; overridden_accounts: number };

const toPolicy = (kind: PolicyKind, row: PolicyRow): GlobalPolicy => ({
  id: row.id,
  kind,
  name: row.name,
  cadence: row.cadence,
  timezone: row.timezone,
  amountUsd: row.amount_usd,
  priority: row.priority,
  enabled: row.enabled,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  overriddenAccounts: row.overridden_accounts,
});

/**
 * Admin changes to global policies. With the engine, the only writer of
 * `billing_*` policy and window rows. Every change is audited in the same
 * transaction.
 */
export class GlobalPolicies {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<GlobalPolicy[]> {
    const [funding, limits] = await Promise.all([
      this.sql<PolicyRow[]>`
        SELECT
          id, name, cadence, timezone, enabled, effective_from, effective_until,
          amount_usd::text AS amount_usd, priority,
          (SELECT count(DISTINCT account_id)::int FROM billing_funding_policies WHERE account_id IS NOT NULL AND enabled) AS overridden_accounts
        FROM billing_funding_policies
        WHERE account_id IS NULL
        ORDER BY effective_until IS NOT NULL, priority, created_at
      `,
      this.sql<PolicyRow[]>`
        SELECT
          id, name, cadence, timezone, enabled, effective_from, effective_until,
          limit_usd::text AS amount_usd, NULL::int AS priority,
          (SELECT count(DISTINCT account_id)::int FROM billing_limit_policies WHERE account_id IS NOT NULL AND enabled) AS overridden_accounts
        FROM billing_limit_policies
        WHERE account_id IS NULL
        ORDER BY effective_until IS NOT NULL, created_at
      `,
    ]);
    return [...funding.map((row) => toPolicy("funding", row)), ...limits.map((row) => toPolicy("limit", row))];
  }

  async create(actorUserId: string, kind: PolicyKind, input: PolicyInput): Promise<string> {
    validate(kind, input);
    return this.sql.begin(async (tx) => {
      const [row] =
        kind === "funding"
          ? await tx<{ id: string }[]>`
              INSERT INTO billing_funding_policies (account_id, name, cadence, timezone, amount_usd, priority, enabled, effective_until)
              VALUES (NULL, ${input.name}, ${input.cadence}, ${input.timezone ?? "UTC"}, ${input.amountUsd.toString()}::numeric,
                ${input.priority ?? 100}, ${input.enabled}, ${input.effectiveUntil ?? null})
              RETURNING id
            `
          : await tx<{ id: string }[]>`
              INSERT INTO billing_limit_policies (account_id, name, cadence, timezone, limit_usd, enabled, effective_until)
              VALUES (NULL, ${input.name}, ${input.cadence}, ${input.timezone ?? "UTC"}, ${input.amountUsd.toString()}::numeric,
                ${input.enabled}, ${input.effectiveUntil ?? null})
              RETURNING id
            `;
      if (!row) throw new Error("PostgreSQL did not return the new policy");
      await recordAdminAction(tx, {
        actorUserId,
        action: "policy_created",
        targetType: `${kind}_policy`,
        targetId: row.id,
        details: { ...input, amountUsd: input.amountUsd.toString() },
      });
      return row.id;
    });
  }

  /**
   * A new amount also applies to the current period's windows, so lowering
   * an allowance or a cap takes effect now rather than at the next period.
   * An allowance never drops below what a window has already used.
   */
  async update(actorUserId: string, kind: PolicyKind, id: string, change: PolicyChange): Promise<void> {
    if (change.name !== undefined) validateName(change.name);
    if (change.amountUsd?.isNegative()) throw new PolicyError("The amount cannot be negative");
    if (change.priority !== undefined && !Number.isInteger(change.priority)) {
      throw new PolicyError("Priority must be a whole number");
    }
    await this.sql.begin(async (tx) => {
      const table = tx(TABLES[kind]);
      const amountColumn = tx(kind === "funding" ? "amount_usd" : "limit_usd");
      const [before] = await tx<{ amount: string; enabled: boolean; effective_from: Date }[]>`
        SELECT ${amountColumn}::text AS amount, enabled, effective_from
        FROM ${table}
        WHERE id = ${id}::uuid AND account_id IS NULL
        FOR UPDATE
      `;
      if (!before) throw new PolicyError("Policy not found");
      if (change.effectiveUntil && change.effectiveUntil <= before.effective_from) {
        throw new PolicyError("The end must be after the start");
      }

      await tx`
        UPDATE ${table}
        SET
          name = COALESCE(${change.name ?? null}, name),
          ${amountColumn} = COALESCE(${change.amountUsd?.toString() ?? null}::numeric, ${amountColumn}),
          enabled = COALESCE(${change.enabled ?? null}, enabled),
          effective_until = ${change.effectiveUntil === undefined ? tx`effective_until` : change.effectiveUntil},
          ${kind === "funding" ? tx`priority = COALESCE(${change.priority ?? null}::int, priority),` : tx``}
          updated_at = now()
        WHERE id = ${id}::uuid
      `;

      if (change.amountUsd && !change.amountUsd.equals(Usd.parse(before.amount))) {
        const amount = change.amountUsd.toString();
        await (kind === "funding"
          ? tx`
              UPDATE billing_funding_windows
              SET granted_usd = GREATEST(${amount}::numeric, reserved_usd + committed_usd), updated_at = now()
              WHERE policy_id = ${id}::uuid AND superseded_at IS NULL AND window_end > now()
            `
          : tx`
              UPDATE billing_limit_windows
              SET limit_usd = ${amount}::numeric, updated_at = now()
              WHERE policy_id = ${id}::uuid AND superseded_at IS NULL AND window_end > now()
            `);
      }

      await recordAdminAction(tx, {
        actorUserId,
        action: "policy_changed",
        targetType: `${kind}_policy`,
        targetId: id,
        details: {
          ...change,
          amountUsd: change.amountUsd?.toString(),
          previousAmountUsd: before.amount,
          previousEnabled: before.enabled,
        },
      });
    });
  }

  /**
   * Deletes a policy that never opened a window. One that did is history
   * the windows still point at, so it is disabled and ended instead.
   */
  async remove(actorUserId: string, kind: PolicyKind, id: string): Promise<"deleted" | "ended"> {
    return this.sql.begin(async (tx) => {
      const table = tx(TABLES[kind]);
      const windows = tx(kind === "funding" ? "billing_funding_windows" : "billing_limit_windows");
      const [policy] = await tx<{ used: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM ${windows} WHERE policy_id = ${id}::uuid) AS used
        FROM ${table}
        WHERE id = ${id}::uuid AND account_id IS NULL
        FOR UPDATE
      `;
      if (!policy) throw new PolicyError("Policy not found");
      if (policy.used) {
        await tx`
          UPDATE ${table}
          SET enabled = false, effective_until = GREATEST(now(), effective_from + INTERVAL '1 microsecond'), updated_at = now()
          WHERE id = ${id}::uuid
        `;
      } else {
        await tx`DELETE FROM ${table} WHERE id = ${id}::uuid`;
      }
      const outcome = policy.used ? "ended" : "deleted";
      await recordAdminAction(tx, { actorUserId, action: `policy_${outcome}`, targetType: `${kind}_policy`, targetId: id });
      return outcome;
    });
  }
}

const validateName = (name: string) => {
  if (name.trim().length < 1 || name.length > 100) throw new PolicyError("Name must be 1–100 characters");
};

const validate = (kind: PolicyKind, input: PolicyInput) => {
  validateName(input.name);
  if (!(CADENCES[kind] as readonly string[]).includes(input.cadence)) {
    throw new PolicyError(`Cadence must be one of ${CADENCES[kind].join(", ")}`);
  }
  if (input.amountUsd.isNegative()) throw new PolicyError("The amount cannot be negative");
  if (input.priority !== undefined && !Number.isInteger(input.priority)) {
    throw new PolicyError("Priority must be a whole number");
  }
  if (input.effectiveUntil && input.effectiveUntil <= new Date()) {
    throw new PolicyError("The end must be in the future");
  }
};
