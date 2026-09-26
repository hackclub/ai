import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import type { ProviderCompletion } from "../types";
import { meterPrediction, type PredictionSettlement } from "./metering";
import type { ReplicatePricing } from "./pricing";

const pricing: ReplicatePricing = {
  kind: "hardware",
  hardware: "T4",
  perSecondUsd: Usd.parse("0.001"),
  medianRunUsd: Usd.parse("0.002"),
};

function expectState<S extends ProviderCompletion["state"]>(
  completion: ProviderCompletion,
  state: S,
): asserts completion is Extract<ProviderCompletion, { state: S }> {
  expect(completion.state).toBe(state);
  if (completion.state !== state) throw new Error(`expected ${state}`);
}

describe("meterPrediction", () => {
  const noSleep = async () => {};
  const meter = (upstream: Response, settlement: Partial<PredictionSettlement> = {}) =>
    meterPrediction(upstream, "{}", {
      pricing,
      lookup: async () => null,
      timeoutMs: 10_000,
      sleep: noSleep,
      ...settlement,
    });
  /** Reads the body to the end, as a client would, then waits for settlement. */
  const settle = async (upstream: Response, settlement?: Partial<PredictionSettlement>) => {
    const metered = meter(upstream, settlement);
    await metered.response.text();
    return metered.completion;
  };

  test("bills a terminal response from its metrics without polling", async () => {
    const lookups: string[] = [];
    const completion = await settle(
      Response.json({ id: "p1", status: "succeeded", metrics: { predict_time: 1.5 } }),
      {
        lookup: async (id) => {
          lookups.push(id);
          return null;
        },
      },
    );
    expectState(completion, "complete");
    expect(completion.usage.costUsd.toString()).toBe(Usd.parse("0.0015").toString());
    expect(completion.providerRequestId).toBe("p1");
    expect(lookups).toEqual([]);
  });

  test("polls an async prediction until it finishes, then bills it", async () => {
    let polls = 0;
    const completion = await settle(Response.json({ id: "p2", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        polls += 1;
        return polls < 3
          ? { id: "p2", status: "processing" }
          : { id: "p2", status: "failed", metrics: { predict_time: 4 } };
      },
    });
    expectState(completion, "complete");
    // A failed run still bills the hardware time Replicate reports.
    expect(completion.usage.costUsd.toString()).toBe(Usd.parse("0.004").toString());
    expect(polls).toBe(3);
  });

  test("treats an aborted prediction as terminal", async () => {
    let polls = 0;
    const completion = await settle(Response.json({ id: "p5", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        polls += 1;
        return { id: "p5", status: "aborted" };
      },
    });
    expectState(completion, "complete");
    expect(completion.usage.costUsd.toString()).toBe(Usd.zero.toString());
    expect(polls).toBe(1);
  });

  test("leaves the reservation uncertain when the prediction never finishes", async () => {
    const completion = await settle(Response.json({ id: "p3", status: "starting" }, { status: 201 }), {
      lookup: async () => ({ id: "p3", status: "processing" }),
      timeoutMs: 1,
      sleep: () => Bun.sleep(2),
    });
    expectState(completion, "uncertain");
    expect(completion.reason).toContain("p3");
    // The id is what reconciliation needs to bill the prediction later.
    expect(completion.providerRequestId).toBe("p3");
  });

  test("retries a transient lookup failure instead of abandoning settlement", async () => {
    let calls = 0;
    const completion = await settle(Response.json({ id: "p10", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        calls += 1;
        if (calls === 1) throw new Error("502 from Replicate");
        return { id: "p10", status: "succeeded", metrics: { predict_time: 1 } };
      },
    });
    expect(completion.state).toBe("complete");
    expect(calls).toBe(2);
  });

  test("gives up after a run of consecutive lookup failures", async () => {
    let calls = 0;
    const completion = await settle(Response.json({ id: "p11", status: "starting" }, { status: 201 }), {
      lookup: async () => {
        calls += 1;
        throw new Error("still down");
      },
    });
    expectState(completion, "uncertain");
    expect(completion.reason).toBe("still down");
    expect(completion.providerRequestId).toBe("p11");
    expect(calls).toBe(5);
  });

  test("settles a cancellation even when the upstream cancel rejects", async () => {
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Buffer.from('{"id":"p7","status":"starting"}'));
        },
        cancel() {
          throw new Error("socket already closed");
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
    const metered = meter(upstream);
    const reader = metered.response.body?.getReader();
    await reader?.read();
    await reader?.cancel("client disconnected");
    const completion = await metered.completion;
    expectState(completion, "uncertain");
    expect(completion.providerRequestId).toBe("p7");
    expect(completion.reason).toBe("client disconnected");
  });

  test("keeps the prediction id when the client cancels while a read is pending", async () => {
    // A cancel that lands while the next upstream read is in flight: that
    // read resolves `done` on the cancelled stream. It must not settle first
    // and drop the id reconciliation needs.
    let pulls = 0;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(Buffer.from('{"id":"p9","status":"starting"}'));
          else return new Promise(() => {});
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
    const metered = meter(upstream);
    const reader = metered.response.body!.getReader();
    await reader.read();
    await Bun.sleep(5);
    expect(pulls).toBe(2);
    await reader.cancel("client disconnected");
    const completion = await metered.completion;
    expectState(completion, "uncertain");
    expect(completion.providerRequestId).toBe("p9");
    expect(completion.reason).toBe("client disconnected");
  });
});
