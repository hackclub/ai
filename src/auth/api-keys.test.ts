import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import { HttpError } from "../gateway/http-error";
import { authenticateApiKey, bearerToken } from "./api-keys";

describe("API key material", () => {
  test("extracts bearer tokens case-insensitively", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer   abc ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});

describe("authenticateApiKey", () => {
  const row = {
    user_id: "u1",
    api_key_id: "k1",
    billing_account_id: "a1",
    billing_account_status: "active",
    is_banned: false,
    is_idv_verified: false,
    skip_idv: false,
  };
  const sqlReturning = (rows: unknown[]) => (async () => rows) as unknown as postgres.Sql;
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpError;
    }
    throw new Error("expected a rejection");
  };

  test("401s without calling sql when authorization is missing", async () => {
    let calls = 0;
    const sql = (async () => {
      calls++;
      return [];
    }) as unknown as postgres.Sql;
    const error = await failure(authenticateApiKey(sql, undefined, { enforceIdv: false }));
    expect(error.status).toBe(401);
    expect(error.message).toBe("Authentication required");
    expect(calls).toBe(0);
  });

  test("401s when no row matches the key", async () => {
    const error = await failure(
      authenticateApiKey(sqlReturning([]), "Bearer sk-hc-v1-x", { enforceIdv: false }),
    );
    expect(error.status).toBe(401);
    expect(error.message).toBe("Authentication failed");
  });

  test("403s a banned user", async () => {
    const error = await failure(
      authenticateApiKey(sqlReturning([{ ...row, is_banned: true }]), "Bearer sk-hc-v1-x", {
        enforceIdv: false,
      }),
    );
    expect(error.status).toBe(403);
    expect(error.message).toBe("You are banned from using this service.");
  });

  test("403s an unverified user when IDV is enforced", async () => {
    const error = await failure(
      authenticateApiKey(
        sqlReturning([{ ...row, is_idv_verified: false, skip_idv: false }]),
        "Bearer sk-hc-v1-x",
        { enforceIdv: true },
      ),
    );
    expect(error.status).toBe(403);
    expect(error.message).toContain("Identity verification required");
  });

  test("resolves when IDV is enforced but the user is exempt", async () => {
    const principal = await authenticateApiKey(
      sqlReturning([{ ...row, is_idv_verified: false, skip_idv: true }]),
      "Bearer sk-hc-v1-x",
      { enforceIdv: true },
    );
    expect(principal.userId).toBe("u1");
  });

  test("resolves when IDV is not enforced even if unverified", async () => {
    const principal = await authenticateApiKey(
      sqlReturning([{ ...row, is_idv_verified: false, skip_idv: false }]),
      "Bearer sk-hc-v1-x",
      { enforceIdv: false },
    );
    expect(principal.userId).toBe("u1");
  });

  test("403s a user without a billing account", async () => {
    const error = await failure(
      authenticateApiKey(
        sqlReturning([{ ...row, billing_account_id: null }]),
        "Bearer sk-hc-v1-x",
        { enforceIdv: false },
      ),
    );
    expect(error.status).toBe(403);
    expect(error.message).toBe("No billing account is attached to this user");
  });

  test("403s a suspended billing account", async () => {
    const error = await failure(
      authenticateApiKey(
        sqlReturning([{ ...row, billing_account_status: "suspended" }]),
        "Bearer sk-hc-v1-x",
        { enforceIdv: false },
      ),
    );
    expect(error.status).toBe(403);
    expect(error.message).toBe("This billing account is suspended.");
  });

  test("resolves the happy path", async () => {
    const principal = await authenticateApiKey(sqlReturning([row]), "Bearer sk-hc-v1-x", {
      enforceIdv: false,
    });
    expect(principal).toEqual({ userId: "u1", apiKeyId: "k1", billingAccountId: "a1" });
  });

  test("bans take precedence over a missing billing account", async () => {
    const error = await failure(
      authenticateApiKey(
        sqlReturning([{ ...row, is_banned: true, billing_account_id: null }]),
        "Bearer sk-hc-v1-x",
        { enforceIdv: false },
      ),
    );
    expect(error.status).toBe(403);
    expect(error.message).toBe("You are banned from using this service.");
  });
});
