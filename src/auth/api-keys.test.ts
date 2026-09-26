import { describe, expect, test } from "bun:test";

import type { HttpError } from "../gateway/http-error";
import { testDatabase } from "../test/database";
import { authenticateApiKey, bearerToken, issueApiKey } from "./api-keys";
import { createUser } from "./users";

const { sql } = await testDatabase();

test("bearerToken extracts bearer tokens case-insensitively", () => {
  expect(bearerToken("Bearer abc")).toBe("abc");
  expect(bearerToken("bearer   abc ")).toBe("abc");
  expect(bearerToken("Basic abc")).toBeNull();
  expect(bearerToken(undefined)).toBeNull();
  expect(bearerToken("Bearer")).toBeNull();
});

describe("authenticateApiKey", () => {
  type Ids = { userId: string; accountId: string };
  let users = 0;
  /** A real user and key; `adjust` changes their rows before authenticating. */
  const keyFor = async (adjust: (ids: Ids) => Promise<unknown>) => {
    const user = await createUser(sql, { slackId: `U-auth-${++users}` });
    const issued = await issueApiKey(sql, user.userId, "test");
    await adjust({ userId: user.userId, accountId: user.billingAccountId });
    return { authorization: `Bearer ${issued.key}`, userId: user.userId, apiKeyId: issued.id, accountId: user.billingAccountId };
  };
  const ban = ({ userId }: Ids) => sql`UPDATE users SET is_banned = true WHERE id = ${userId}`;
  const detachAccount = ({ accountId }: Ids) =>
    sql`UPDATE billing_accounts SET owner_id = gen_random_uuid() WHERE id = ${accountId}`;
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a rejection");
      },
      (error: HttpError) => error,
    );

  test.each([
    ["a banned user", ban, false, "You are banned from using this service."],
    ["an unverified user when IDV is enforced", async () => {}, true, "Identity verification required"],
    ["a user without a billing account", detachAccount, false, "No billing account is attached"],
    [
      "a suspended billing account",
      ({ accountId }: Ids) => sql`UPDATE billing_accounts SET status = 'suspended' WHERE id = ${accountId}`,
      false,
      "This billing account is suspended.",
    ],
    [
      "a banned user before a missing billing account",
      async (ids: Ids) => {
        await ban(ids);
        await detachAccount(ids);
      },
      false,
      "You are banned",
    ],
  ])("403s %s", async (_name, adjust, enforceIdv, message) => {
    const { authorization } = await keyFor(adjust);
    const error = await failure(authenticateApiKey(sql, authorization, { enforceIdv }));
    expect(error.status).toBe(403);
    expect(error.message).toStartWith(message);
  });

  test.each([
    ["the user is IDV-exempt", ({ userId }: Ids) => sql`UPDATE users SET skip_idv = true WHERE id = ${userId}`, true],
    ["IDV is not enforced", async () => {}, false],
    [
      "the user is verified",
      ({ userId }: Ids) => sql`UPDATE users SET is_idv_verified = true WHERE id = ${userId}`,
      true,
    ],
  ])("resolves the principal when %s", async (_name, adjust, enforceIdv) => {
    const { authorization, userId, apiKeyId, accountId } = await keyFor(adjust);
    expect(await authenticateApiKey(sql, authorization, { enforceIdv })).toEqual({
      userId,
      apiKeyId,
      billingAccountId: accountId,
    });
  });
});
