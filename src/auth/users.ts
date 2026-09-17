import type postgres from "postgres";

import { generateApiKey } from "./api-keys";

type Sql = postgres.Sql;

export type CreateUserInput = {
  slackId: string;
  email?: string | null;
  name?: string | null;
  avatar?: string | null;
  /** Recurring daily allowance in USD. Defaults to the previous gateway's $3. */
  dailyAllowanceUsd?: string;
};

export type CreatedUser = {
  userId: string;
  billingAccountId: string;
};

/**
 * Creates the user, its billing account, and a daily allowance in one
 * transaction so an authenticated user can never exist without funding
 * policy rows to reserve against.
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

    await tx`
      INSERT INTO billing_funding_policies (
        account_id, name, cadence, amount_usd, priority
      )
      VALUES (
        ${account.id}::uuid,
        'Daily allowance',
        'day',
        ${input.dailyAllowanceUsd ?? "3"}::numeric,
        100
      )
    `;

    return { userId: user.id, billingAccountId: account.id };
  });
}

export type IssuedApiKey = {
  id: string;
  /** The plaintext key. It is shown once and never stored. */
  key: string;
  keyPrefix: string;
};

export async function issueApiKey(
  sql: Sql,
  userId: string,
  name: string,
): Promise<IssuedApiKey> {
  const generated = generateApiKey();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
    VALUES (
      ${userId}::uuid,
      ${generated.keyHash},
      ${generated.keyPrefix},
      ${name}
    )
    RETURNING id
  `;
  if (!row) throw new Error("PostgreSQL did not return the new API key");
  return { id: row.id, key: generated.key, keyPrefix: generated.keyPrefix };
}

export async function revokeApiKey(sql: Sql, userId: string, apiKeyId: string) {
  await sql`
    UPDATE api_keys
    SET revoked_at = now()
    WHERE id = ${apiKeyId}::uuid AND user_id = ${userId}::uuid AND revoked_at IS NULL
  `;
}
