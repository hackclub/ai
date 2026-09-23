import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import type { FinalizeInput, Reservation } from "./engine";
import { Usd } from "./money";
import {
  expireStaleReservations,
  fetchOpenRouterGeneration,
  type ReconcileOptions,
  reconcilePendingReservations,
} from "./reconciliation";

const minute = 60_000;
const day = 24 * 60 * minute;
const notFound = () => new Response("", { status: 404 });

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

const openRouterUnused = openRouter(() => {
  throw new Error("OpenRouter must not be consulted");
});

const replicate = (respond: (url: string) => Response) => ({
  apiKey: "rkey",
  pricing: {
    get: async () => ({
      kind: "hardware" as const,
      hardware: "T4",
      perSecondUsd: Usd.parse("0.001"),
      medianRunUsd: null,
    }),
  },
  fetch: (async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rkey");
    return respond(String(input));
  }) as typeof fetch,
});

/** A pending row as the SELECT returns it; `expired` is the database's verdict. */
const pending = (
  requestId: string,
  providerRequestId: string | null,
  ageMs: number,
  provider = "openrouter",
) => ({
  request_id: requestId,
  provider,
  provider_request_id: providerRequestId,
  reconciliation_reason: "client disconnected",
  expired: ageMs >= day,
  age_ms: ageMs,
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

/** A fake `sql` that answers every SELECT with `rows` and records each query's text. */
const fakeSql = (rows: unknown[]) => {
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    return text.trim().startsWith("SELECT") ? rows : [];
  }) as unknown as postgres.Sql;
  return { sql, queries };
};

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

const reconcile = async (
  rows: unknown[],
  options: Partial<Pick<ReconcileOptions, "openRouter" | "replicate" | "log">> = {},
) => {
  const { sql, queries } = fakeSql(rows);
  const { billing, finalized, released } = fakeBilling();
  const result = await reconcilePendingReservations({
    sql,
    billing,
    openRouter: openRouterUnused,
    ...options,
  });
  const deferred = queries.some((query) => query.includes("UPDATE billing_reservations"));
  return { result, finalized, released, deferred };
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
    if (lookup.state !== "found") throw new Error("expected found");
    expect(lookup.generation.totalCostUsd.toString()).toBe("0.000420000000");
    expect(lookup.generation.promptTokens).toBe(5);
    expect(lookup.generation.completionTokens).toBe(7);
    expect(lookup.generation.model).toBe("test/model");
  });

  test("treats 404 as not yet available and other errors as failures", async () => {
    expect(await fetchOpenRouterGeneration("x", openRouter(notFound))).toEqual({ state: "not_found" });
    await expect(
      fetchOpenRouterGeneration("x", openRouter(() => new Response("", { status: 500 }))),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("reconcilePendingReservations with OpenRouter", () => {
  test("finalizes with the provider's cost and a reconciled analytics event, without deferring", async () => {
    const { result, finalized, deferred } = await reconcile([pending("r1", "gen-1", minute)], {
      openRouter: openRouter(() => generationResponse(0.002)),
    });
    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 0 });
    expect(deferred).toBe(false);
    const [input] = finalized;
    expect(input?.actualCostUsd.toString()).toBe("0.002000000000");
    expect(input?.usageSource).toBe("reconciled");
    expect(input?.providerRequestId).toBe("gen-1");
    expect(input?.analytics?.outcome).toBe("reconciled");
    expect(input?.analytics?.input_tokens).toBe(5);
    expect(input?.analytics?.request_body).toBe("");
    expect(input?.analytics?.attributes).toEqual({
      body_capture: "none",
      reconciliation_reason: "client disconnected",
    });
  });

  test("waits for young reservations and releases old ones without a record", async () => {
    const { result, finalized, released } = await reconcile(
      [
        pending("young-missing", "gen-young", minute),
        pending("old-missing", "gen-old", day + minute),
        pending("young-no-id", null, minute),
        pending("old-no-id", null, day + minute),
      ],
      { openRouter: openRouter(notFound) },
    );
    expect(result).toEqual({ finalized: 0, released: 2, skipped: 2, failed: 0 });
    expect(finalized).toEqual([]);
    expect(released.sort()).toEqual(["old-missing", "old-no-id"]);
  });

  test("counts per-row failures and keeps going", async () => {
    let calls = 0;
    const { result, finalized } = await reconcile(
      [pending("r1", "gen-1", minute), pending("r2", "gen-2", minute)],
      {
        openRouter: openRouter(() =>
          calls++ === 0 ? new Response("", { status: 500 }) : generationResponse(0.001, "gen-2"),
        ),
      },
    );
    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 1 });
    expect(finalized[0]?.requestId).toBe("r2");
  });

  test("trusts the database's expiry verdict and logs an age beyond int4 raw", async () => {
    const logs: string[] = [];
    const { result, released } = await reconcile(
      [
        { ...pending("db-says-expired", null, minute), expired: true },
        { ...pending("ancient", null, 0), expired: true, age_ms: "3000000000" },
      ],
      { openRouter: openRouter(notFound), log: (message) => logs.push(message) },
    );
    expect(result).toEqual({ finalized: 0, released: 2, skipped: 0, failed: 0 });
    expect(released).toEqual(["db-says-expired", "ancient"]);
    expect(logs.some((line) => line.includes("3000000000ms"))).toBe(true);
  });
});

describe("reconcilePendingReservations with Replicate", () => {
  test("bills a finished prediction from its metrics and the model's live pricing", async () => {
    const { result, finalized } = await reconcile([pending("r1", "pred1", minute, "replicate")], {
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

  test("keeps a running prediction pending however old it is, deferring it to the back of the queue", async () => {
    const { result, released, deferred } = await reconcile(
      [pending("old-running", "pred2", 2 * day, "replicate")],
      { replicate: replicate(() => Response.json({ id: "pred2", status: "processing" })) },
    );
    expect(result).toEqual({ finalized: 0, released: 0, skipped: 1, failed: 0 });
    expect(released).toEqual([]);
    expect(deferred).toBe(true);
  });

  test("releases an old prediction Replicate no longer knows", async () => {
    const { result, released } = await reconcile([pending("gone", "pred3", day + minute, "replicate")], {
      replicate: replicate(notFound),
    });
    expect(result).toEqual({ finalized: 0, released: 1, skipped: 0, failed: 0 });
    expect(released).toEqual(["gone"]);
  });

  test("skips rows when Replicate access is not configured", async () => {
    const { result } = await reconcile([pending("young", "pred4", minute, "replicate")]);
    expect(result).toEqual({ finalized: 0, released: 0, skipped: 1, failed: 0 });
  });
});

test("expireStaleReservations releases every expired reservation independently", async () => {
  const { billing, released } = fakeBilling();
  billing.release = async (requestId: string) => {
    if (requestId === "bad") throw new Error("locked");
    released.push(requestId);
    return reservation(requestId, "released");
  };
  const result = await expireStaleReservations({
    sql: fakeSql([{ request_id: "a" }, { request_id: "bad" }, { request_id: "b" }]).sql,
    billing,
  });
  expect(result).toEqual({ released: 2, failed: 1 });
  expect(released).toEqual(["a", "b"]);
});
