import type postgres from "postgres";

type Sql = postgres.Sql;

/** Shown to a banned user by the proxy, `/api` and the dashboard. */
export const BANNED_MESSAGE = "You are banned from using this service.";

export type CreateUserInput = {
  slackId: string;
  email?: string | null;
  name?: string | null;
  avatar?: string | null;
  /** A daily allowance of the user's own, in USD, replacing the global allowances. */
  dailyAllowanceUsd?: string;
};

export type CreatedUser = {
  userId: string;
  billingAccountId: string;
};

/**
 * Creates the user and its billing account in one transaction. The account
 * is funded by the global policies unless it is given an allowance of its own.
 */
export async function createUser(
  sql: Sql,
  input: CreateUserInput,
): Promise<CreatedUser> {
  return sql.begin(async (tx) => {
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO users (slack_id, email, name, avatar)
      VALUES (
        ${input.slackId},
        ${input.email ?? null},
        ${input.name ?? null},
        ${input.avatar ?? null}
      )
      RETURNING id
    `;
    if (!user) throw new Error("PostgreSQL did not return the new user");

    const [account] = await tx<{ id: string }[]>`
      INSERT INTO billing_accounts (owner_type, owner_id)
      VALUES ('user', ${user.id}::uuid)
      RETURNING id
    `;
    if (!account) throw new Error("PostgreSQL did not return the new account");

    if (input.dailyAllowanceUsd !== undefined) {
      await tx`
        INSERT INTO billing_funding_policies (
          account_id, name, cadence, amount_usd, priority
        )
        VALUES (
          ${account.id}::uuid,
          'Daily allowance',
          'day',
          ${input.dailyAllowanceUsd}::numeric,
          100
        )
      `;
    }

    return { userId: user.id, billingAccountId: account.id };
  });
}
