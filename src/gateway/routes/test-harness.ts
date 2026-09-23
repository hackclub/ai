import type postgres from "postgres";

import { createUser, issueApiKey } from "../../auth/users";
import type { FinalizeInput, Reservation, ReserveInput } from "../../billing/engine";
import type { Fetch } from "../../providers/openrouter/adapter";
import { type BillingLifecycle, SettlementTracker } from "../metered-request";

export type BillingCall =
  | { method: "reserve"; input: ReserveInput }
  | { method: "finalize"; input: FinalizeInput }
  | { method: "release"; requestId: string }
  | {
      method: "markPendingReconciliation";
      requestId: string;
      reason: string;
      providerRequestId: string | undefined;
    };

const reservationFor = (requestId: string, state: Reservation["state"]): Reservation => ({
  id: `res-${requestId}`,
  requestId,
  accountId: "account-1",
  provider: "test",
  providerRequestId: null,
  state,
  estimatedCostUsd: "0.000000000000",
  actualCostUsd: null,
  unfundedCostUsd: "0.000000000000",
  expiresAt: new Date(0),
});

/**
 * In-memory billing that records every call. `settled()` waits for the
 * settlements started so far, since routes do not hand them back.
 */
export const fakeBilling = (overrides: Partial<BillingLifecycle> = {}) => {
  const calls: BillingCall[] = [];
  const settlements = new SettlementTracker();
  const billing: BillingLifecycle = {
    settlements,
    async reserve(input) {
      calls.push({ method: "reserve", input });
      return reservationFor(input.requestId, "reserved");
    },
    async finalize(input) {
      calls.push({ method: "finalize", input });
      return reservationFor(input.requestId, "finalized");
    },
    async release(requestId) {
      calls.push({ method: "release", requestId });
      return reservationFor(requestId, "released");
    },
    async markPendingReconciliation(requestId, reason, providerRequestId) {
      calls.push({ method: "markPendingReconciliation", requestId, reason, providerRequestId });
      return reservationFor(requestId, "pending_reconciliation");
    },
    ...overrides,
  };
  const inputs = <M extends "reserve" | "finalize">(method: M) =>
    calls.flatMap((call) => (call.method === method ? [call.input] : [])) as Array<
      M extends "reserve" ? ReserveInput : FinalizeInput
    >;
  const only = <M extends BillingCall["method"]>(method: M) => {
    const matching = calls.filter((call): call is Extract<BillingCall, { method: M }> => call.method === method);
    if (matching.length !== 1) throw new Error(`Expected exactly one ${method}, got ${matching.length}`);
    return matching[0]!;
  };
  return {
    billing,
    calls,
    settlements,
    only,
    methods: () => calls.map((call) => call.method),
    reserves: () => inputs("reserve"),
    finalizes: () => inputs("finalize"),
    settled: () => settlements.drain(1_000),
  };
};

export const principalRow = {
  api_key_id: "key-1",
  user_id: "user-1",
  billing_account_id: "account-1",
  billing_account_status: "active",
  is_banned: false,
  is_idv_verified: true,
  skip_idv: false,
};

/** Answers the api-key lookup; `answer` may handle other queries first. */
export const fakeSql = (answer: (query: string) => unknown[] | undefined = () => undefined) =>
  (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    return answer(query) ?? (query.includes("FROM api_keys") ? [principalRow] : []);
  }) as unknown as postgres.Sql;

/** A fetch that records each upstream call and answers with `respond`. */
export const fakeFetch = (respond: (url: string) => Response | Promise<Response>) => {
  const upstream: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fetch: Fetch = async (input, init) => {
    upstream.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return respond(String(input));
  };
  return { fetch, upstream };
};

export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer sk-hc-v1-test", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A user, billing account and API key in a real database, with a teardown that removes everything they touched. */
export const createTestAccount = async (sql: postgres.Sql, label: string) => {
  const user = await createUser(sql, { slackId: `U-${label}`, dailyAllowanceUsd: "1" });
  const accountId = user.billingAccountId;
  const apiKey = (await issueApiKey(sql, user.userId, label)).key;
  const cleanup = async () => {
    await sql`DELETE FROM request_event_outbox WHERE payload->>'account_id' = ${accountId}`;
    const reservations = sql`SELECT id FROM billing_reservations WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_ledger_entries WHERE account_id = ${accountId}::uuid`;
    for (const table of [
      "billing_reservation_funding_holds",
      "billing_reservation_credit_holds",
      "billing_reservation_limit_holds",
    ]) {
      await sql`DELETE FROM ${sql(table)} WHERE reservation_id IN (${reservations})`;
    }
    for (const table of ["billing_reservations", "billing_funding_windows", "billing_funding_policies"]) {
      await sql`DELETE FROM ${sql(table)} WHERE account_id = ${accountId}::uuid`;
    }
    await sql`DELETE FROM billing_accounts WHERE id = ${accountId}::uuid`;
    await sql`DELETE FROM users WHERE id = ${user.userId}::uuid`;
  };
  return { userId: user.userId, accountId, apiKey, cleanup };
};
