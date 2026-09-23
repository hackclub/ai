import type postgres from "postgres";

import { issueApiKey } from "../../auth/api-keys";
import { createUser } from "../../auth/users";
import { BillingEngine, type JsonValue } from "../../billing/engine";
import type { ReservationState } from "../../billing/lifecycle";
import type { Fetch } from "../../providers/openrouter/adapter";
import { type BillingLifecycle, SettlementTracker } from "../metered-request";

/**
 * The real billing engine for gateway tests (docs/adr/0001), with the
 * settlement tracker routes report to. `settled()` waits for the
 * settlements started so far, since routes do not hand them back.
 */
export const testBilling = (sql: postgres.Sql) => {
  const settlements = new SettlementTracker();
  const billing: BillingLifecycle = new BillingEngine(sql);
  return { billing, settlements, settled: () => settlements.drain(5_000) };
};

export type BillingRecord = {
  requestId: string;
  provider: string;
  state: ReservationState;
  providerRequestId: string | null;
  reconciliationReason: string | null;
  estimatedCostUsd: string;
  actualCostUsd: string | null;
  usageSource: string | null;
  /** The analytics event finalization wrote to the outbox, if any. */
  event: Record<string, JsonValue> | null;
};

/**
 * What billing recorded for an account, oldest first: each reservation's
 * final state and its outbox event. Tests assert on this, not on calls.
 */
export const billingRecords = async (sql: postgres.Sql, accountId: string): Promise<BillingRecord[]> => {
  const rows = await sql<
    Array<Omit<BillingRecord, "event"> & { event: Record<string, JsonValue> | null }>
  >`
    SELECT
      r.request_id AS "requestId",
      r.provider,
      r.state,
      r.provider_request_id AS "providerRequestId",
      r.reconciliation_reason AS "reconciliationReason",
      r.estimated_cost_usd::text AS "estimatedCostUsd",
      r.actual_cost_usd::text AS "actualCostUsd",
      r.usage_source AS "usageSource",
      o.payload AS event
    FROM billing_reservations r
    LEFT JOIN request_event_outbox o ON o.payload->>'reservation_id' = r.id::text
    WHERE r.account_id = ${accountId}::uuid
    ORDER BY r.created_at, r.id
  `;
  return [...rows];
};

/**
 * The real engine with some operations replaced, for fault injection only:
 * a failure the database cannot be made to produce on demand. Everything not
 * overridden still runs against PostgreSQL.
 */
export const withFaults = (billing: BillingLifecycle, faults: Partial<BillingLifecycle>): BillingLifecycle => ({
  reserve: (input) => billing.reserve(input),
  finalize: (input) => billing.finalize(input),
  release: (requestId) => billing.release(requestId),
  markPendingReconciliation: (requestId, reason, providerRequestId) =>
    billing.markPendingReconciliation(requestId, reason, providerRequestId),
  ...faults,
});

/** The account's only reservation; throws when there is not exactly one. */
export const onlyBillingRecord = async (sql: postgres.Sql, accountId: string) => {
  const records = await billingRecords(sql, accountId);
  if (records.length !== 1) throw new Error(`Expected exactly one reservation, got ${records.length}`);
  return records[0]!;
};

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

/**
 * A user, billing account (with a $1 daily allowance) and API key. Nothing
 * to clean up: every test file starts with an empty database.
 */
export const createTestAccount = async (sql: postgres.Sql, label: string) => {
  const user = await createUser(sql, { slackId: `U-${label}`, dailyAllowanceUsd: "1" });
  const apiKey = (await issueApiKey(sql, user.userId, label)).key;
  return { userId: user.userId, accountId: user.billingAccountId, apiKey };
};
