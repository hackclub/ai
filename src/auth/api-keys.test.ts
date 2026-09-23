import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import type { HttpError } from "../gateway/http-error";
import { authenticateApiKey, bearerToken } from "./api-keys";

test("bearerToken extracts bearer tokens case-insensitively", () => {
  expect(bearerToken("Bearer abc")).toBe("abc");
  expect(bearerToken("bearer   abc ")).toBe("abc");
  expect(bearerToken("Basic abc")).toBeNull();
  expect(bearerToken(undefined)).toBeNull();
  expect(bearerToken("Bearer")).toBeNull();
});

describe("authenticateApiKey", () => {
  const row = {
    user_id: "u1",
    api_key_id: "k1",
    billing_account_id: "a1" as string | null,
    billing_account_status: "active",
    is_banned: false,
    is_idv_verified: false,
    skip_idv: false,
  };
  const KEY = "Bearer sk-hc-v1-x";
  const sqlReturning = (rows: unknown[]) => (async () => rows) as unknown as postgres.Sql;
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a rejection");
      },
      (error: HttpError) => error,
    );

  test("401s without calling sql when authorization is missing", async () => {
    let calls = 0;
    const sql = (async () => {
      calls++;
      return [];
    }) as unknown as postgres.Sql;
    const error = await failure(authenticateApiKey(sql, undefined, { enforceIdv: false }));
    expect([error.status, error.message]).toEqual([401, "Authentication required"]);
    expect(calls).toBe(0);
  });

  test("401s when no row matches the key", async () => {
    const error = await failure(authenticateApiKey(sqlReturning([]), KEY, { enforceIdv: false }));
    expect([error.status, error.message]).toEqual([401, "Authentication failed"]);
  });

  test.each([
    ["a banned user", { is_banned: true }, false, "You are banned from using this service."],
    ["an unverified user when IDV is enforced", {}, true, "Identity verification required"],
    ["a user without a billing account", { billing_account_id: null }, false, "No billing account is attached"],
    ["a suspended billing account", { billing_account_status: "suspended" }, false, "This billing account is suspended."],
    ["a banned user before a missing billing account", { is_banned: true, billing_account_id: null }, false, "You are banned"],
  ])("403s %s", async (_name, overrides, enforceIdv, message) => {
    const error = await failure(authenticateApiKey(sqlReturning([{ ...row, ...overrides }]), KEY, { enforceIdv }));
    expect(error.status).toBe(403);
    expect(error.message).toStartWith(message);
  });

  test.each([
    ["the user is IDV-exempt", { skip_idv: true }, true],
    ["IDV is not enforced", {}, false],
    ["the user is verified", { is_idv_verified: true }, true],
  ])("resolves the principal when %s", async (_name, overrides, enforceIdv) => {
    const principal = await authenticateApiKey(sqlReturning([{ ...row, ...overrides }]), KEY, { enforceIdv });
    expect(principal).toEqual({ userId: "u1", apiKeyId: "k1", billingAccountId: "a1" });
  });
});
