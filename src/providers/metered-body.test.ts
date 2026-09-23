import { describe, expect, test } from "bun:test";

import { Usd } from "../billing/money";
import {
  type CapturedBody,
  type CancelPolicy,
  isEventStream,
  meterBuffered,
  meterStreamed,
  type UsageReader,
  type UsageVerdict,
} from "./metered-body";
import type { NormalizedUsage } from "./types";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const usage: NormalizedUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: Usd.parse("0.001") };
const CANCEL: CancelPolicy = { kind: "cancel-upstream" };

type Part = Uint8Array | (() => Promise<Uint8Array | null>);

/**
 * A pull-based upstream: each pull yields the next part, a part given as a
 * function is awaited (so a read can be left pending), and the stream closes
 * after the last part. Records upstream cancels.
 */
const upstream = (parts: Part[], init: ResponseInit & { failAfter?: boolean; cancelThrows?: boolean } = {}) => {
  const cancels: unknown[] = [];
  const { failAfter, cancelThrows, ...responseInit } = init;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts.shift();
      if (part === undefined) {
        if (failAfter) controller.error(new Error("socket reset"));
        else controller.close();
        return;
      }
      const chunk = typeof part === "function" ? await part() : part;
      if (chunk === null) controller.close();
      else controller.enqueue(chunk);
    },
    cancel(reason) {
      cancels.push(reason);
      if (cancelThrows) throw new Error("socket already closed");
    },
  });
  return { response: new Response(body, responseInit), cancels };
};

/** A reader that records every call and returns `verdict`. */
const recording = (verdict: Partial<UsageVerdict> | ((body: CapturedBody) => UsageVerdict | Promise<UsageVerdict>) = {}) => {
  const bodies: CapturedBody[] = [];
  const observed: Uint8Array[] = [];
  const reader: UsageReader = {
    observe: (chunk) => observed.push(chunk),
    read: (body) => {
      bodies.push(body);
      return typeof verdict === "function"
        ? verdict(body)
        : { usage: null, providerRequestId: null, reason: "no usage", ...verdict };
    },
  };
  return { reader, bodies, observed };
};

const stream = (
  response: Response,
  reader: UsageReader,
  options: { maxCapturedBytes?: number | null; headers?: "upstream" | "forwardable"; onCancel?: CancelPolicy } = {},
) =>
  meterStreamed(response, {
    requestBody: "{}",
    reader,
    maxCapturedBytes: options.maxCapturedBytes ?? null,
    headers: options.headers ?? "upstream",
    onCancel: options.onCancel ?? CANCEL,
  });

const readAll = async (response: Response) => {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
};

const never = () => new Promise<Uint8Array | null>(() => {});

describe("meterStreamed", () => {
  test("forwards exactly the upstream chunks and lets the reader observe copies", async () => {
    // A multi-byte character split across chunks must reach the caller as sent.
    const sent = [bytes("data: h"), new Uint8Array([0xc3]), new Uint8Array([0xa9, 0x0a]), bytes("\n")];
    const { response } = upstream([...sent]);
    const { reader, observed, bodies } = recording();
    const metered = stream(response, reader);

    const received = await readAll(metered.response);
    expect(received).toEqual(sent);
    received.forEach((chunk, index) => expect(chunk).toBe(sent[index]!));
    expect(observed).toEqual(sent);
    observed.forEach((chunk, index) => expect(chunk).not.toBe(sent[index]!));
    await metered.completion;
    expect(bodies[0]?.text).toBe("data: hé\n\n");
  });

  test("calls the reader once when the body ends, and a later cancel changes nothing", async () => {
    const { response } = upstream([bytes("a"), bytes("b")]);
    const { reader, bodies } = recording();
    const metered = stream(response, reader);
    const body = metered.response.body!.getReader();
    while (!(await body.read()).done);
    await body.cancel("late");
    await metered.completion;
    await Bun.sleep(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.end).toEqual({ kind: "done" });
    expect(bodies[0]?.text).toBe("ab");
  });

  test("an upstream error ends the body once, with what was captured", async () => {
    const { response } = upstream([bytes("partial")], { failAfter: true });
    const { reader, bodies } = recording();
    const metered = stream(response, reader);
    await expect(readAll(metered.response)).rejects.toThrow("socket reset");
    const completion = await metered.completion;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.end.kind).toBe("error");
    expect(completion).toMatchObject({ state: "uncertain", reason: "no usage", responseBody: "partial", bodyCapture: "partial" });
  });

  test("a read still pending when the client cancels is dropped; the cancel decides", async () => {
    // Today's Replicate metering lost the prediction id here: the pending
    // read resolved `done`, closing the cancelled controller threw, and the
    // error path settled first without the id.
    const first = '{"id":"p9","status":"starting"}';
    const { response, cancels } = upstream([bytes(first), never], { status: 201 });
    const { reader, bodies, observed } = recording((body) => ({
      usage: null,
      providerRequestId: body.end.kind === "cancelled" ? "p9" : null,
      reason: "cancelled",
    }));
    const metered = stream(response, reader);
    const client = metered.response.body!.getReader();
    await client.read();
    await Bun.sleep(5); // the second pull is now awaiting the upstream read
    await client.cancel("client disconnected");

    const completion = await metered.completion;
    await Bun.sleep(1);
    expect(cancels).toEqual(["client disconnected"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.end).toEqual({ kind: "cancelled", reason: "client disconnected" });
    expect(bodies[0]?.text).toBe(first);
    expect(observed).toHaveLength(1);
    expect(completion).toMatchObject({ state: "uncertain", providerRequestId: "p9", reason: "cancelled" });
  });

  test("stops capturing at the first chunk that overflows the cap, and stays stopped", async () => {
    const sent = [bytes("1234"), bytes("0123456789"), bytes("ab")];
    const { response } = upstream([...sent]);
    const { reader, bodies, observed } = recording({ usage });
    const metered = stream(response, reader, { maxCapturedBytes: 8 });
    expect(await readAll(metered.response)).toEqual(sent);
    const completion = await metered.completion;
    expect(bodies[0]).toMatchObject({ text: "1234", truncated: true });
    // Every chunk is still observed for usage.
    expect(observed).toHaveLength(3);
    expect(completion).toMatchObject({ state: "complete", bodyCapture: "truncated", responseBody: "1234" });
  });

  test("a null cap keeps everything", async () => {
    const big = "x".repeat(4 * 1024 * 1024);
    const { response } = upstream([bytes(big), bytes("!")]);
    const { reader, bodies } = recording();
    const metered = stream(response, reader, { maxCapturedBytes: null });
    await readAll(metered.response);
    await metered.completion;
    expect(bodies[0]?.truncated).toBeFalse();
    expect(bodies[0]?.text).toBe(`${big}!`);
  });

  test("decodes the capture once, after the end", async () => {
    // "é" split across chunks: a per-chunk decode would produce two U+FFFD.
    const { response } = upstream([new Uint8Array([0x61, 0xc3]), new Uint8Array([0xa9])]);
    const { reader, bodies } = recording();
    const metered = stream(response, reader);
    await readAll(metered.response);
    await metered.completion;
    expect(bodies[0]?.text).toBe("aé");
  });

  describe("completion mapping", () => {
    const run = async (
      verdict: Partial<UsageVerdict>,
      init: ResponseInit = {},
      parts: Uint8Array[] = [bytes("body")],
      options: { maxCapturedBytes?: number; cancel?: boolean } = {},
    ) => {
      const { response } = upstream([...parts, never].slice(0, options.cancel ? undefined : parts.length), init);
      const metered = stream(response, recording(verdict).reader, { maxCapturedBytes: options.maxCapturedBytes });
      if (options.cancel) {
        const client = metered.response.body!.getReader();
        await client.read();
        await client.cancel("bye");
      } else {
        await readAll(metered.response);
      }
      return metered.completion;
    };

    test("usage is complete whatever the status", async () => {
      expect(await run({ usage }, { status: 500 })).toMatchObject({ state: "complete", usage, bodyCapture: "complete" });
      expect(await run({ usage }, {}, [bytes("123456789")], { maxCapturedBytes: 4 })).toMatchObject({
        state: "complete",
        bodyCapture: "truncated",
      });
    });

    test("no usage on a non-2xx status is a provider error", async () => {
      expect(await run({ reason: "refused" }, { status: 502 })).toEqual({
        state: "provider_error",
        providerRequestId: null,
        responseBody: "body",
        bodyCapture: "complete",
      });
    });

    test("no usage on a non-2xx status the provider may still bill is uncertain", async () => {
      expect(await run({ reason: "gateway timeout", mayStillBeCharged: true }, { status: 504 })).toMatchObject({
        state: "uncertain",
        reason: "gateway timeout",
        bodyCapture: "complete",
      });
    });

    test("no usage on a 2xx status is uncertain, with how much of the body was seen", async () => {
      expect(await run({ reason: "missing" })).toMatchObject({ state: "uncertain", reason: "missing", bodyCapture: "complete" });
      expect(await run({ reason: "missing" }, {}, [bytes("body")], { cancel: true })).toMatchObject({
        state: "uncertain",
        bodyCapture: "partial",
      });
      expect(await run({ reason: "missing" }, {}, [bytes("123456789")], { maxCapturedBytes: 4 })).toMatchObject({
        state: "uncertain",
        bodyCapture: "truncated",
      });
    });

    test("carries the id, the replacement body and the model on every state", async () => {
      const carried = { providerRequestId: "gen-1", responseBody: "[redacted]", model: "m@v2" };
      for (const [verdict, init] of [
        [{ usage }, {}],
        [{}, { status: 400 }],
        [{ reason: "missing" }, {}],
      ] as const) {
        expect(await run({ ...verdict, ...carried }, init)).toMatchObject(carried);
      }
    });
  });

  test.each([
    ["throws", () => {
      throw new Error("reader bug");
    }],
    ["rejects", async () => {
      throw new Error("reader bug");
    }],
  ] as const)("a reader that %s resolves uncertain, never rejects", async (_name, read) => {
    for (const status of [200, 500]) {
      const { response } = upstream([bytes("x")], { status });
      const metered = stream(response, { read });
      await readAll(metered.response);
      expect(await metered.completion).toMatchObject({
        state: "uncertain",
        reason: "completion_rejected",
        providerRequestId: null,
        responseBody: "x",
      });
    }
  });

  test("cancel-upstream settles even when the upstream cancel rejects", async () => {
    const { response, cancels } = upstream([bytes("a"), bytes("b")], { cancelThrows: true });
    const { reader, bodies } = recording();
    const metered = stream(response, reader);
    const client = metered.response.body!.getReader();
    await client.read();
    await client.cancel("bye");
    const completion = await metered.completion;
    expect(cancels).toEqual(["bye"]);
    expect(bodies[0]?.end).toEqual({ kind: "cancelled", reason: "bye" });
    expect(completion).toMatchObject({ state: "uncertain", bodyCapture: "partial" });
  });

  describe("drain", () => {
    const later = (text: string, ms = 5) => async () => {
      await Bun.sleep(ms);
      return bytes(text);
    };
    const cancelAfterFirst = async (response: Response) => {
      const client = response.body!.getReader();
      await client.read();
      await client.cancel("client gone");
    };

    test("keeps reading after the cancel until the end, forwarding nothing", async () => {
      const { response, cancels } = upstream([bytes("a"), later("b"), later("c")]);
      const { reader, bodies, observed } = recording();
      const metered = stream(response, reader, { onCancel: { kind: "drain", timeoutMs: 1_000 } });
      await cancelAfterFirst(metered.response);
      await metered.completion;
      expect(cancels).toEqual([]);
      // The read in flight at the cancel is taken over, not repeated or lost.
      expect(bodies[0]).toMatchObject({ text: "abc", end: { kind: "cancelled", reason: "client gone", drain: "finished" } });
      expect(observed.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["a", "b", "c"]);
    });

    test("cancels the upstream when the drain times out", async () => {
      const { response, cancels } = upstream([bytes("a"), never]);
      const { reader, bodies } = recording();
      const metered = stream(response, reader, { onCancel: { kind: "drain", timeoutMs: 10 } });
      await cancelAfterFirst(metered.response);
      await metered.completion;
      expect(cancels).toEqual(["drain timeout"]);
      expect(bodies[0]?.end).toMatchObject({ kind: "cancelled", drain: "timed_out" });
    });

    test("reports a read error while draining as failed", async () => {
      const { response } = upstream([bytes("a"), later("b")], { failAfter: true });
      const { reader, bodies } = recording();
      const metered = stream(response, reader, { onCancel: { kind: "drain", timeoutMs: 1_000 } });
      await cancelAfterFirst(metered.response);
      await metered.completion;
      expect(bodies[0]).toMatchObject({ text: "ab", end: { kind: "cancelled", drain: "failed" } });
    });
  });

  test("with no body, settles at once and returns the upstream response itself", async () => {
    const response = new Response(null, { status: 200 });
    const { reader, bodies } = recording();
    const metered = stream(response, reader);
    expect(metered.response).toBe(response);
    await metered.completion;
    expect(bodies[0]).toMatchObject({ text: "", truncated: false, end: { kind: "done" } });
  });

  test("passes upstream headers unchanged, or only the forwardable ones", async () => {
    const headers = { "content-type": "text/event-stream", "cf-ray": "abc", "set-cookie": "s=1" };
    const raw = upstream([bytes("x")], { headers }).response;
    // cf-ray and set-cookie survive: analytics read upstream headers such as cf-ray.
    expect(Object.fromEntries(stream(raw, recording().reader).response.headers)).toEqual(Object.fromEntries(raw.headers));
    expect(raw.headers.get("cf-ray")).toBe("abc");
    const filtered = stream(upstream([bytes("x")], { headers }).response, recording().reader, { headers: "forwardable" });
    expect([...filtered.response.headers.keys()]).toEqual(["content-type"]);
    expect(isEventStream(filtered.response.headers)).toBeTrue();
    expect(isEventStream(new Headers({ "content-type": "application/json" }))).toBeFalse();
  });
});

describe("meterBuffered", () => {
  test("reads the whole body first and returns it with the completion settled", async () => {
    const wire = '{"id":"r1","cost":1}';
    const { response } = upstream([bytes(wire.slice(0, 5)), bytes(wire.slice(5))], {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json", "set-cookie": "s=1" },
    });
    const { reader, bodies } = recording({ usage, providerRequestId: "r1" });
    const metered = await meterBuffered(response, { requestBody: '{"q":1}', reader, headers: "forwardable" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ text: wire, status: 201, end: { kind: "done" } });
    expect(await Promise.race([metered.completion, Promise.resolve("pending")])).toMatchObject({
      state: "complete",
      providerRequestId: "r1",
    });
    expect(metered.response).not.toBe(response);
    expect(metered.response.status).toBe(201);
    expect(metered.response.statusText).toBe("Created");
    expect(metered.response.headers.get("set-cookie")).toBeNull();
    expect(await metered.response.text()).toBe(wire);
    expect(metered.requestBody).toBe('{"q":1}');
  });

  test("rejects when the body cannot be read", async () => {
    const { response } = upstream([bytes("partial")], { failAfter: true });
    const { reader, bodies } = recording();
    await expect(meterBuffered(response, { requestBody: "{}", reader, headers: "upstream" })).rejects.toThrow(
      "socket reset",
    );
    expect(bodies).toHaveLength(0);
  });
});
