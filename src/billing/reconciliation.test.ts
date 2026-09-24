import { beforeEach, describe, expect, test } from "bun:test";

import { billingRecords, createTestAccount, onlyBillingRecord } from "../gateway/routes/test-harness";
import { EXA, exaProvider } from "../providers/exa/provider";
import { mistralProvider } from "../providers/mistral/provider";
import type { OpenRouterConfig } from "../providers/openrouter/generation";
import { openRouterProvider } from "../providers/openrouter/provider";
import { type ProviderModule, providerRegistry } from "../providers/provider";
import {
  REPLICATE_FILES,
  type ReplicateProviderConfig,
  replicateFilesProvider,
  replicateProvider,
} from "../providers/replicate/provider";
import { typesafeProvider } from "../providers/typesafe/provider";
import { testDatabase } from "../test/database";
import { BillingEngine } from "./engine";
import { Usd } from "./money";
import {
  expireStaleReservations,
  type ReconcileOptions,
  reconcilePendingReservations,
} from "./reconciliation";

const { sql } = await testDatabase();
const engine = new BillingEngine(sql);

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

const replicate = (respond: (url: string) => Response): ReplicateProviderConfig => ({
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

const replicateUnused = replicate(() => {
  throw new Error("Replicate must not be consulted");
});

/** Provider request ids are unique per provider in the database. */
const uniqueId = (prefix: string) => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;

/**
 * Reconciliation sweeps every account, so each test starts with nothing
 * left unsettled by an earlier one: leftovers are released by the engine.
 */
beforeEach(async () => {
  const open = await sql<{ request_id: string }[]>`
    SELECT request_id FROM billing_reservations WHERE state IN ('reserved', 'pending_reconciliation')
  `;
  for (const { request_id } of open) await engine.release(request_id);
});

const newAccount = async () => (await createTestAccount(sql, crypto.randomUUID())).accountId;

/** A real reservation on `accountId`. `age` backdates it (created_at and updated_at) on the database clock. */
const reserve = async (
  accountId: string,
  { provider = "openrouter", age }: { provider?: string; age?: string } = {},
) => {
  const requestId = crypto.randomUUID();
  await engine.reserve({
    requestId,
    accountId,
    provider,
    estimatedCostUsd: Usd.parse("0.01"),
    userId: null,
    apiKeyId: null,
    endpoint: "chat/completions",
  });
  if (age) {
    await sql`
      UPDATE billing_reservations
      SET created_at = now() - ${age}::interval, updated_at = now() - ${age}::interval
      WHERE request_id = ${requestId}::uuid
    `;
  }
  return requestId;
};

/** A reservation the gateway could not settle, as it reaches the reconciliation queue. */
const pending = async (
  accountId: string,
  providerRequestId: string | null,
  options: { provider?: string; age?: string } = {},
) => {
  const requestId = await reserve(accountId, options);
  await engine.markPendingReconciliation(requestId, "client disconnected", providerRequestId ?? undefined);
  if (options.age) {
    // markPendingReconciliation touches updated_at; keep the row's place in the queue.
    await sql`
      UPDATE billing_reservations SET updated_at = created_at WHERE request_id = ${requestId}::uuid
    `;
  }
  return requestId;
};

const stateOf = async (requestId: string) => {
  const [row] = await sql<{ state: string; deferred: boolean }[]>`
    SELECT state, updated_at > now() - INTERVAL '1 minute' AS deferred
    FROM billing_reservations WHERE request_id = ${requestId}::uuid
  `;
  return row;
};

/**
 * Reconciles through a registry of the real provider modules, each with a
 * faked upstream. A provider whose upstream a test does not name throws if
 * consulted; `replicate: null` leaves Replicate unregistered.
 */
const reconcile = ({
  openRouter = openRouterUnused,
  replicate = replicateUnused,
  ...options
}: Partial<Omit<ReconcileOptions, "sql" | "billing" | "providers">> & {
  openRouter?: OpenRouterConfig;
  replicate?: ReplicateProviderConfig | null;
} = {}) => {
  const modules: ProviderModule[] = [
    openRouterProvider(openRouter),
    replicateFilesProvider,
    exaProvider,
    mistralProvider,
    typesafeProvider,
  ];
  if (replicate) modules.push(replicateProvider(replicate));
  return reconcilePendingReservations({ sql, billing: engine, providers: providerRegistry(modules), ...options });
};

describe("reconcilePendingReservations with OpenRouter", () => {
  test("finalizes with the provider's cost and a reconciled analytics event", async () => {
    const accountId = await newAccount();
    const generationId = uniqueId("gen-");
    await pending(accountId, generationId);

    const result = await reconcile({
      openRouter: openRouter((url) => {
        expect(url).toBe(`https://upstream.test/api/v1/generation?id=${generationId}`);
        return generationResponse(0.002, generationId);
      }),
    });

    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 0 });
    const record = await onlyBillingRecord(sql, accountId);
    expect(record).toMatchObject({
      state: "finalized",
      actualCostUsd: "0.002000000000",
      usageSource: "reconciled",
      providerRequestId: generationId,
      // Settling clears the reason on the row; the event keeps it.
      reconciliationReason: null,
    });
    expect(record.event).toMatchObject({
      outcome: "reconciled",
      usage_source: "reconciled",
      model: "test/model",
      input_tokens: 5,
      output_tokens: 7,
      provider_cost_usd: "0.002000000000",
      billed_cost_usd: "0.002000000000",
      request_body: "",
      attributes: { body_capture: "none", reconciliation_reason: "client disconnected" },
    });
  });

  test("waits for young reservations and releases old ones without a record", async () => {
    const accountId = await newAccount();
    // Young rows are backdated too, so a deferral visibly moves updated_at.
    const youngMissing = await pending(accountId, uniqueId("gen-young-"), { age: "5 minutes" });
    const oldMissing = await pending(accountId, uniqueId("gen-old-"), { age: "24 hours 1 minute" });
    const youngNoId = await pending(accountId, null, { age: "5 minutes" });
    const oldNoId = await pending(accountId, null, { age: "24 hours 1 minute" });

    const result = await reconcile({ openRouter: openRouter(notFound) });

    expect(result).toEqual({ finalized: 0, released: 2, skipped: 2, failed: 0 });
    expect(await stateOf(youngMissing)).toEqual({ state: "pending_reconciliation", deferred: true });
    expect(await stateOf(youngNoId)).toEqual({ state: "pending_reconciliation", deferred: true });
    expect((await stateOf(oldMissing))?.state).toBe("released");
    expect((await stateOf(oldNoId))?.state).toBe("released");
    expect((await billingRecords(sql, accountId)).filter((record) => record.event)).toEqual([]);
  });

  test("counts per-row failures and keeps going", async () => {
    const accountId = await newAccount();
    const failing = await pending(accountId, uniqueId("gen-500-"));
    const okId = uniqueId("gen-ok-");
    const ok = await pending(accountId, okId);

    const result = await reconcile({
      openRouter: openRouter((url) =>
        url.endsWith(okId) ? generationResponse(0.001, okId) : new Response("", { status: 500 }),
      ),
    });

    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 1 });
    expect((await stateOf(failing))?.state).toBe("pending_reconciliation");
    expect((await stateOf(ok))?.state).toBe("finalized");
  });

  test("rotates a failed lookup so a later reservation can progress next pass", async () => {
    const accountId = await newAccount();
    const failedProviderId = uniqueId("gen-failed-");
    const nextProviderId = uniqueId("gen-next-");
    const failed = await pending(accountId, failedProviderId, { age: "2 minutes" });
    const next = await pending(accountId, nextProviderId, { age: "1 minute" });
    const provider = openRouter((url) =>
      url.endsWith(nextProviderId)
        ? generationResponse(0.001, nextProviderId)
        : new Response("", { status: 500 }),
    );

    expect(await reconcile({ openRouter: provider, limit: 1 })).toEqual({ finalized: 0, released: 0, skipped: 0, failed: 1 });
    expect(await reconcile({ openRouter: provider, limit: 1 })).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 0 });
    expect((await stateOf(failed))?.state).toBe("pending_reconciliation");
    expect((await stateOf(next))?.state).toBe("finalized");
  });

  test("decides expiry on the database clock and logs an age beyond int4 raw", async () => {
    const accountId = await newAccount();
    const justExpired = await pending(accountId, null, { age: "61 seconds" });
    const notYet = await pending(accountId, null, { age: "59 seconds" });
    // About 3.5e9 ms, past int4's 2^31.
    const ancient = await pending(accountId, null, { age: "40 days" });
    const logs: string[] = [];

    const result = await reconcile({ maxAgeMs: 60_000, log: (message) => logs.push(message) });

    expect(result).toEqual({ finalized: 0, released: 2, skipped: 1, failed: 0 });
    expect((await stateOf(justExpired))?.state).toBe("released");
    expect((await stateOf(notYet))?.state).toBe("pending_reconciliation");
    expect((await stateOf(ancient))?.state).toBe("released");
    const ancientAge = logs
      .find((line) => line.includes(ancient))
      ?.match(/after (\d+)ms/)?.[1];
    expect(Number(ancientAge)).toBeGreaterThan(40 * 24 * 60 * 60 * 1_000 - 1);
  });
});

describe("reconcilePendingReservations with Replicate", () => {
  test("bills a finished prediction from its metrics and the model's live pricing", async () => {
    const accountId = await newAccount();
    const predictionId = uniqueId("pred");
    await pending(accountId, predictionId, { provider: "replicate" });

    const result = await reconcile({
      replicate: replicate((url) => {
        expect(url).toBe(`https://api.replicate.com/v1/predictions/${predictionId}`);
        return Response.json({
          id: predictionId,
          status: "succeeded",
          model: "owner/name",
          metrics: { predict_time: 2 },
        });
      }),
    });

    expect(result).toEqual({ finalized: 1, released: 0, skipped: 0, failed: 0 });
    const record = await onlyBillingRecord(sql, accountId);
    expect(record).toMatchObject({
      state: "finalized",
      actualCostUsd: "0.002000000000",
      usageSource: "reconciled",
      providerRequestId: predictionId,
    });
    expect(record.event?.model).toBe("owner/name");
  });

  test("keeps a running prediction pending however old it is, deferring it to the back of the queue", async () => {
    const accountId = await newAccount();
    const first = uniqueId("pred");
    const second = uniqueId("pred");
    const oldest = await pending(accountId, first, { provider: "replicate", age: "3 days" });
    const older = await pending(accountId, second, { provider: "replicate", age: "2 days" });
    const looked: string[] = [];
    const running = replicate((url) => {
      const id = url.split("/").at(-1) ?? "";
      looked.push(id);
      return Response.json({ id, status: "processing" });
    });

    // One row per pass: the deferred row goes behind the other.
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await reconcile({ replicate: running, limit: 1 })).toEqual({
        finalized: 0,
        released: 0,
        skipped: 1,
        failed: 0,
      });
    }

    expect(looked).toEqual([first, second, first]);
    expect(await stateOf(oldest)).toEqual({ state: "pending_reconciliation", deferred: true });
    expect(await stateOf(older)).toEqual({ state: "pending_reconciliation", deferred: true });
  });

  test("releases an old prediction Replicate no longer knows", async () => {
    const accountId = await newAccount();
    const gone = await pending(accountId, uniqueId("pred"), { provider: "replicate", age: "24 hours 1 minute" });

    const result = await reconcile({ replicate: replicate(notFound) });

    expect(result).toEqual({ finalized: 0, released: 1, skipped: 0, failed: 0 });
    expect((await stateOf(gone))?.state).toBe("released");
  });

});

describe("reconcilePendingReservations without a lookup", () => {
  test("a provider without a registered module is deferred, then released after the max age", async () => {
    const accountId = await newAccount();
    const young = await pending(accountId, uniqueId("pred"), { provider: "replicate", age: "5 minutes" });
    const old = await pending(accountId, uniqueId("pred"), { provider: "replicate", age: "25 hours" });

    expect(await reconcile({ replicate: null })).toEqual({ finalized: 0, released: 1, skipped: 1, failed: 0 });
    expect(await stateOf(young)).toEqual({ state: "pending_reconciliation", deferred: true });
    expect((await stateOf(old))?.state).toBe("released");
  });

  test("an unknown provider key behaves like one without a lookup", async () => {
    const accountId = await newAccount();
    const young = await pending(accountId, uniqueId("x"), { provider: "no-such-provider", age: "5 minutes" });
    const old = await pending(accountId, uniqueId("x"), { provider: "no-such-provider", age: "25 hours" });

    expect(await reconcile()).toEqual({ finalized: 0, released: 1, skipped: 1, failed: 0 });
    expect(await stateOf(young)).toEqual({ state: "pending_reconciliation", deferred: true });
    expect((await stateOf(old))?.state).toBe("released");
  });

  test("an exa row with a provider id is never looked up: deferred while young, released when old", async () => {
    const accountId = await newAccount();
    // Every upstream throws if consulted, so a lookup would count as failed.
    const young = await pending(accountId, uniqueId("exa-"), { provider: EXA, age: "5 minutes" });
    const old = await pending(accountId, uniqueId("exa-"), { provider: EXA, age: "24 hours 1 minute" });

    expect(await reconcile()).toEqual({ finalized: 0, released: 1, skipped: 1, failed: 0 });
    expect(await stateOf(young)).toEqual({ state: "pending_reconciliation", deferred: true });
    expect((await stateOf(old))?.state).toBe("released");
  });

  test("an old replicate-files row is released without any lookup", async () => {
    const accountId = await newAccount();
    // Every upstream throws if consulted, so a lookup would count as failed.
    const old = await pending(accountId, uniqueId("file"), { provider: REPLICATE_FILES, age: "25 hours" });

    expect(await reconcile()).toEqual({ finalized: 0, released: 1, skipped: 0, failed: 0 });
    expect((await stateOf(old))?.state).toBe("released");
    expect((await billingRecords(sql, accountId)).filter((record) => record.event)).toEqual([]);
  });
});

test("expireStaleReservations releases every expired reservation independently", async () => {
  const accountId = await newAccount();
  const a = await reserve(accountId);
  const bad = await reserve(accountId);
  const b = await reserve(accountId);
  const live = await reserve(accountId);
  await sql`
    UPDATE billing_reservations SET expires_at = now() - INTERVAL '1 minute'
    WHERE request_id IN ${sql([a, bad, b])}
  `;
  // Fault injection: one release fails; the rest still run on the real engine.
  const billing = {
    release: async (requestId: string) => {
      if (requestId === bad) throw new Error("locked");
      return engine.release(requestId);
    },
  };

  const result = await expireStaleReservations({ sql, billing });

  expect(result).toEqual({ released: 2, failed: 1 });
  expect((await stateOf(a))?.state).toBe("released");
  expect((await stateOf(b))?.state).toBe("released");
  expect((await stateOf(bad))?.state).toBe("reserved");
  expect((await stateOf(live))?.state).toBe("reserved");
});
