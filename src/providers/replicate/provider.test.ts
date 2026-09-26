import { beforeEach, describe, expect, test } from "bun:test";

import { BillingEngine } from "../../billing/engine";
import { Usd } from "../../billing/money";
import { reconcilePendingReservations } from "../../billing/reconciliation";
import { createTestAccount, onlyBillingRecord } from "../../gateway/routes/test-harness";
import { testDatabase } from "../../test/database";
import { providerRegistry } from "../provider";
import { meterPrediction } from "./metering";
import type { TerminalPrediction } from "./predictions";
import type { ReplicatePricing } from "./pricing";
import { REPLICATE, replicateProvider } from "./provider";

const { sql } = await testDatabase();
const engine = new BillingEngine(sql);

const pricing: ReplicatePricing = {
  kind: "hardware",
  hardware: "T4",
  perSecondUsd: Usd.parse("0.001"),
  medianRunUsd: null,
};

/** Terminal snapshots and what the one billability rule makes of them. */
const cases: Array<{
  name: string;
  prediction: Omit<TerminalPrediction, "id">;
  charged: string | null;
}> = [
  { name: "succeeded with predict_time", prediction: { status: "succeeded", metrics: { predict_time: 2 } }, charged: "0.002" },
  { name: "succeeded with only total_time", prediction: { status: "succeeded", metrics: { total_time: 3 } }, charged: null },
  { name: "failed with predict_time", prediction: { status: "failed", metrics: { predict_time: 1 } }, charged: "0.001" },
  { name: "canceled without metrics", prediction: { status: "canceled" }, charged: "0" },
];

const predictionId = () => `pred${crypto.randomUUID().replaceAll("-", "")}`;

/** Reconciliation sweeps every account; start each test with nothing left pending. */
beforeEach(async () => {
  const open = await sql<{ request_id: string }[]>`
    SELECT request_id FROM billing_reservations WHERE state IN ('reserved', 'pending_reconciliation')
  `;
  for (const { request_id } of open) await engine.release(request_id);
});

describe("live and reconciled settlement bill through the same rule", () => {
  for (const { name, prediction, charged } of cases) {
    test(name, async () => {
      const id = predictionId();
      const snapshot = { id, ...prediction };

      // Live: the prediction response is metered as the route meters it.
      const metered = meterPrediction(Response.json(snapshot, { status: 201 }), "{}", {
        pricing,
        lookup: async () => null,
        timeoutMs: 1_000,
        sleep: async () => {},
      });
      await metered.response.text();
      const live = await metered.completion;

      // Reconciled: the same prediction, left pending, is looked up later.
      const { accountId } = await createTestAccount(sql, crypto.randomUUID());
      const requestId = crypto.randomUUID();
      await engine.reserve({
        requestId,
        accountId,
        provider: REPLICATE,
        estimatedCostUsd: Usd.parse("0.01"),
        userId: null,
        apiKeyId: null,
        endpoint: "replicate/predictions",
      });
      await engine.markPendingReconciliation(requestId, "client disconnected", id);
      const lookups: string[] = [];
      await reconcilePendingReservations({
        sql,
        billing: engine,
        providers: providerRegistry([
          replicateProvider({
            apiKey: "rkey",
            pricing: { get: async () => pricing },
            fetch: (async (input: string | URL | Request) => {
              lookups.push(String(input));
              return Response.json({ ...snapshot, model: "owner/name" });
            }) as typeof fetch,
          }),
        ]),
      });
      const record = await onlyBillingRecord(sql, accountId);
      expect(lookups).toEqual([`https://api.replicate.com/v1/predictions/${id}`]);

      if (charged === null) {
        expect(live).toMatchObject({
          state: "uncertain",
          providerRequestId: id,
          reason: `Prediction ${id} succeeded without billable metrics`,
        });
        expect(record.state).toBe("pending_reconciliation");
      } else {
        if (live.state !== "complete") throw new Error(`expected complete, got ${live.state}`);
        expect(live.usage.costUsd.equals(Usd.parse(charged))).toBe(true);
        expect(live.providerRequestId).toBe(id);
        expect(record.state).toBe("finalized");
        expect(record.usageSource).toBe("reconciled");
        expect(Usd.parse(record.actualCostUsd!).equals(Usd.parse(charged))).toBe(true);
      }
    });
  }
});
