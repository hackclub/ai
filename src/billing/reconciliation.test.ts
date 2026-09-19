import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import type { FinalizeInput, Reservation } from "./engine";
import { Usd } from "./money";
import {
  expireStaleReservations,
  fetchOpenRouterGeneration,
  reconcilePendingReservations,
} from "./reconciliation";

const generationResponse = (cost: number, id = "gen-1") =>
  Response.json({
    data: { id, model: "test/model", total_cost: cost, native_tokens_prompt: 5, native_tokens_completion: 7 },
  });

const openRouter = (respond: (url: string) => Response) => ({
  apiKey: "key",
  baseUrl: "https://upstream.test/api/",
  fetch: (async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
    return respond(String(input));
  }) as typeof fetch,
});

const reservation = (requestId: string, state: Reservation["state"]): Reservation => ({
  id: `res-${requestId}`,
  requestId,
  accountId: "acct",
  provider: "openrouter",
  providerRequestId: null,
  state,
  estimatedCostUsd: "0.010000000000",
  actualCostUsd: null,
  unfundedCostUsd: "0.000000000000",
  expiresAt: new Date(0),
});

/** A fake `sql` tagged template that returns scripted rows for any query. */
const fakeSql = (rows: unknown[]) =>
  (async () => rows) as unknown as postgres.Sql;

const fakeBilling = () => {
  const finalized: FinalizeInput[] = [];
  const released: string[] = [];
  return {
    finalized,
    released,
    billing: {
      async finalize(input: FinalizeInput) {
        finalized.push(input);
        return reservation(input.requestId, "finalized");
      },
      async release(requestId: string) {
        released.push(requestId);
        return reservation(requestId, "released");
      },
    },
  };
};

describe("fetchOpenRouterGeneration", () => {
  test("parses the generation record", async () => {
    const lookup = await fetchOpenRouterGeneration(
      "gen-1",
      openRouter((url) => {
        expect(url).toBe("https://upstream.test/api/v1/generation?id=gen-1");
        return generationResponse(0.00042);
      }),
    );
    expect(lookup.state).toBe("found");
    if (lookup.state !== "found") throw new Error("expected found");
    expect(lookup.generation.totalCostUsd.toString()).toBe("0.000420000000");
    expect(lookup.generation.promptTokens).toBe(5);
    expect(lookup.generation.completionTokens).toBe(7);
    expect(lookup.generation.model).toBe("test/model");
  });

  test("treats 404 as not yet available and other errors as failures", async () => {
    expect(
      await fetchOpenRouterGeneration("x", openRouter(() => new Response("", { status: 404 }))),
    ).toEqual({ state: "not_found" });
    await expect(
      fetchOpenRouterGeneration("x", openRouter(() => new Response("", { status: 500 }))),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("reconcilePendingReservations", () => {
  const minute = 60_000;
  const maxAge = 24 * 60 * minute;
  const pending = (requestId: string, providerRequestId: string | null, ageMs: number) => ({
    request_id: requestId,
    provider: "openrouter",
    provider_request_id: providerRequestId,
    reconciliation_reason: "client disconnected",
    expired: ageMs >= maxAge,
    age_ms: ageMs,
  });

  test("finalizes with the provider's recorded cost and a reconciled analytics event", async () => {
    const { billing, finalized } = fakeBilling();
    const result = await reconcilePendingReservations({
      sql: fakeSql([pending("r1", "gen-1", minute)]),
      billing,
      openRouter: openRouter(() => generationResponse(0.002)),
    });
    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 0 });
    expect(finalized[0]?.actualCostUsd.toString()).toBe("0.002000000000");
    expect(finalized[0]?.usageSource).toBe("reconciled");
    expect(finalized[0]?.providerRequestId).toBe("gen-1");
    expect(finalized[0]?.analytics?.outcome).toBe("reconciled");
    expect(finalized[0]?.analytics?.input_tokens).toBe(5);
    expect(finalized[0]?.analytics?.request_body).toBe("");
    expect(finalized[0]?.analytics?.attributes).toEqual({
      body_capture: "none",
      reconciliation_reason: "client disconnected",
    });
  });

  test("waits for young reservations and releases old ones without a record", async () => {
    const { billing, finalized, released } = fakeBilling();
    const result = await reconcilePendingReservations({
      sql: fakeSql([
        pending("young-missing", "gen-young", minute),
        pending("old-missing", "gen-old", 25 * 60 * minute),
        pending("young-no-id", null, minute),
        pending("old-no-id", null, 25 * 60 * minute),
      ]),
      billing,
      openRouter: openRouter(() => new Response("", { status: 404 })),
    });
    expect(result).toEqual({ finalized: 0, released: 2, skipped: 2, failed: 0 });
    expect(finalized).toEqual([]);
    expect(released.sort()).toEqual(["old-missing", "old-no-id"]);
  });

  test("counts per-row failures and keeps going", async () => {
    const { billing, finalized } = fakeBilling();
    let calls = 0;
    const result = await reconcilePendingReservations({
      sql: fakeSql([pending("r1", "gen-1", minute), pending("r2", "gen-2", minute)]),
      billing,
      openRouter: openRouter(() =>
        calls++ === 0 ? new Response("", { status: 500 }) : generationResponse(0.001, "gen-2"),
      ),
    });
    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 1 });
    expect(finalized[0]?.requestId).toBe("r2");
  });

  test("trusts the database's expiry verdict rather than recomputing it", async () => {
    const { billing, released } = fakeBilling();
    const result = await reconcilePendingReservations({
      sql: fakeSql([{ ...pending("db-says-expired", null, minute), expired: true }]),
      billing,
      openRouter: openRouter(() => new Response("", { status: 404 })),
    });
    expect(result).toEqual({ finalized: 0, released: 1, skipped: 0, failed: 0 });
    expect(released).toEqual(["db-says-expired"]);
  });
});

describe("reconcilePendingReservations for Replicate", () => {
  const minute = 60_000;
  const maxAge = 24 * 60 * minute;
  const pending = (requestId: string, providerRequestId: string | null, ageMs: number) => ({
    request_id: requestId,
    provider: "replicate",
    provider_request_id: providerRequestId,
    reconciliation_reason: "did not finish within the settlement window",
    expired: ageMs >= maxAge,
    age_ms: ageMs,
  });
  const pricing = {
    get: async () => ({
      kind: "hardware" as const,
      hardware: "T4",
      perSecondUsd: Usd.parse("0.001"),
      medianRunUsd: null,
    }),
  };
  const replicate = (respond: (url: string) => Response) => ({
    apiKey: "rkey",
    pricing,
    fetch: (async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rkey");
      return respond(String(input));
    }) as typeof fetch,
  });
  const openRouterUnused = openRouter(() => {
    throw new Error("OpenRouter must not be consulted for Replicate rows");
  });

  test("bills a finished prediction from its metrics and the model's live pricing", async () => {
    const { billing, finalized } = fakeBilling();
    const result = await reconcilePendingReservations({
      sql: fakeSql([pending("r1", "pred1", minute)]),
      billing,
      openRouter: openRouterUnused,
      replicate: replicate((url) => {
        expect(url).toBe("https://api.replicate.com/v1/predictions/pred1");
        return Response.json({
          id: "pred1",
          status: "succeeded",
          model: "owner/name",
          metrics: { predict_time: 2 },
        });
      }),
    });
    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 0 });
    expect(finalized[0]?.actualCostUsd.toString()).toBe("0.002000000000");
    expect(finalized[0]?.providerRequestId).toBe("pred1");
    expect(finalized[0]?.analytics?.model).toBe("owner/name");
  });

  test("keeps a running prediction pending however old it is", async () => {
    const { billing, finalized, released } = fakeBilling();
    const result = await reconcilePendingReservations({
      sql: fakeSql([pending("old-running", "pred2", 48 * 60 * minute)]),
      billing,
      openRouter: openRouterUnused,
      replicate: replicate(() => Response.json({ id: "pred2", status: "processing" })),
    });
    expect(result).toEqual({ finalized: 0, released: 0, skipped: 1, failed: 0 });
    expect(finalized).toEqual([]);
    expect(released).toEqual([]);
  });

  test("releases an old prediction Replicate no longer knows, and skips rows without Replicate access", async () => {
    const { billing, released } = fakeBilling();
    const withAccess = await reconcilePendingReservations({
      sql: fakeSql([pending("gone", "pred3", 25 * 60 * minute)]),
      billing,
      openRouter: openRouterUnused,
      replicate: replicate(() => new Response("", { status: 404 })),
    });
    expect(withAccess).toEqual({ finalized: 0, released: 1, skipped: 0, failed: 0 });
    expect(released).toEqual(["gone"]);

    const withoutAccess = await reconcilePendingReservations({
      sql: fakeSql([pending("young", "pred4", minute)]),
      billing,
      openRouter: openRouterUnused,
    });
    expect(withoutAccess).toEqual({ finalized: 0, released: 0, skipped: 1, failed: 0 });
  });
});

describe("reconcilePendingReservations queue rotation", () => {
  const minute = 60_000;

  const openRouterPending = (requestId: string, providerRequestId: string | null, ageMs: number) => ({
    request_id: requestId,
    provider: "openrouter",
    provider_request_id: providerRequestId,
    reconciliation_reason: "client disconnected",
    expired: false,
    age_ms: ageMs,
  });
  const replicatePending = (requestId: string, providerRequestId: string | null, ageMs: number) => ({
    request_id: requestId,
    provider: "replicate",
    provider_request_id: providerRequestId,
    reconciliation_reason: "did not finish within the settlement window",
    expired: false,
    age_ms: ageMs,
  });
  const pricing = {
    get: async () => ({
      kind: "hardware" as const,
      hardware: "T4",
      perSecondUsd: Usd.parse("0.001"),
      medianRunUsd: null,
    }),
  };
  const replicate = (respond: (url: string) => Response) => ({
    apiKey: "rkey",
    pricing,
    fetch: (async (input) => respond(String(input))) as typeof fetch,
  });

  /** A fake `sql` that records every call's template text and only answers the SELECT. */
  const recordingSql = (rows: unknown[]) => {
    const calls: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      calls.push(text);
      return text.trim().startsWith("SELECT") ? rows : [];
    }) as unknown as postgres.Sql;
    return { sql, calls };
  };

  test("an age beyond PostgreSQL's int4 range does not throw and is logged raw", async () => {
    const { billing, released } = fakeBilling();
    const logs: string[] = [];
    const result = await reconcilePendingReservations({
      sql: fakeSql([
        {
          request_id: "ancient",
          provider: "openrouter",
          provider_request_id: null,
          reconciliation_reason: null,
          expired: true,
          age_ms: "3000000000",
        },
      ]),
      billing,
      openRouter: openRouter(() => new Response("", { status: 404 })),
      log: (message) => logs.push(message),
    });
    expect(result).toEqual({ finalized: 0, released: 1, skipped: 0, failed: 0 });
    expect(released).toEqual(["ancient"]);
    expect(logs.some((line) => line.includes("3000000000ms"))).toBe(true);
  });

  test("defers a not-ready row to the back of the queue", async () => {
    const { billing } = fakeBilling();
    const { sql, calls } = recordingSql([replicatePending("r1", "pred1", minute)]);
    const result = await reconcilePendingReservations({
      sql,
      billing,
      openRouter: openRouter(() => {
        throw new Error("OpenRouter must not be consulted for Replicate rows");
      }),
      replicate: replicate(() => Response.json({ id: "pred1", status: "processing" })),
    });
    expect(result).toEqual({ finalized: 0, released: 0, skipped: 1, failed: 0 });
    expect(
      calls.some(
        (call) => call.includes("UPDATE billing_reservations") && call.includes("SET updated_at = now()"),
      ),
    ).toBe(true);
  });

  test("does not defer a row that was finalized", async () => {
    const { billing, finalized } = fakeBilling();
    const { sql, calls } = recordingSql([openRouterPending("r1", "gen-1", minute)]);
    const result = await reconcilePendingReservations({
      sql,
      billing,
      openRouter: openRouter(() => generationResponse(0.002)),
    });
    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 0 });
    expect(finalized).toHaveLength(1);
    expect(calls.some((call) => call.includes("UPDATE billing_reservations"))).toBe(false);
  });
});

describe("expireStaleReservations", () => {
  test("releases every expired reservation independently", async () => {
    const { billing, released } = fakeBilling();
    billing.release = async (requestId: string) => {
      if (requestId === "bad") throw new Error("locked");
      released.push(requestId);
      return reservation(requestId, "released");
    };
    const result = await expireStaleReservations({
      sql: fakeSql([{ request_id: "a" }, { request_id: "bad" }, { request_id: "b" }]),
      billing,
    });
    expect(result).toEqual({ released: 2, failed: 1 });
    expect(released).toEqual(["a", "b"]);
  });
});
