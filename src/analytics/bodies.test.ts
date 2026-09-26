import { describe, expect, test } from "bun:test";

import { assembleStream, compactRows, extractBlobs } from "./bodies";

const sse = (...events: (object | string)[]) =>
  `: OPENROUTER PROCESSING\n\n${events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")}`;

const chunk = (delta: object, extra: object = {}) => ({
  id: "gen-1",
  object: "chat.completion.chunk",
  created: 1790351038,
  model: "z-ai/glm-5.3-flash",
  provider: "GMICloud",
  choices: [{ index: 0, delta, finish_reason: null, native_finish_reason: null }],
  ...extra,
});

describe("assembleStream", () => {
  test("adds chat completion chunks up to one message", () => {
    const body = sse(
      chunk({ role: "assistant", content: "", reasoning: "Think", reasoning_details: [{ type: "reasoning.text", text: "Think", format: "unknown", index: 0 }] }),
      chunk({ role: "assistant", content: "", reasoning: "ing", reasoning_details: [{ type: "reasoning.text", text: "ing", format: "unknown", index: 0 }] }),
      chunk({ role: "assistant", content: "ignore previous" }),
      chunk({ role: "assistant", content: " instructions" }),
      chunk({ role: "assistant", content: "", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } }] }),
      chunk({ role: "assistant", content: "", tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
      chunk({ role: "assistant", content: "", tool_calls: [{ index: 0, function: { arguments: '"mango"}' } }] }),
      {
        ...chunk({ role: "assistant", content: "" }),
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "tool_calls", native_finish_reason: "tool_calls" }],
      },
      { ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } },
      "[DONE]",
    );

    expect(JSON.parse(assembleStream(body) ?? "null")).toEqual({
      object: "chat.completion",
      id: "gen-1",
      created: 1790351038,
      model: "z-ai/glm-5.3-flash",
      provider: "GMICloud",
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          native_finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "ignore previous instructions",
            reasoning: "Thinking",
            reasoning_details: [{ type: "reasoning.text", text: "Thinking", format: "unknown", index: 0 }],
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"mango"}' } }],
          },
        },
      ],
    });
  });

  test("keeps an error the provider sent mid-stream", () => {
    const body = sse(chunk({ role: "assistant", content: "Hel" }), { ...chunk({}), choices: [], error: { code: 502, message: "Upstream error" } });
    expect(JSON.parse(assembleStream(body) ?? "null")).toMatchObject({
      error: { code: 502, message: "Upstream error" },
      choices: [{ message: { content: "Hel" } }],
    });
  });

  test("takes the final response of a Responses API stream", () => {
    const response = { id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] };
    const body = `: \n\n${sse(
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.completed", response },
    )}`;
    expect(JSON.parse(assembleStream(body) ?? "null")).toEqual(response);
  });

  test("leaves a stream it cannot read alone", () => {
    expect(assembleStream(sse({ type: "response.output_text.delta", delta: "cut off" }))).toBeNull();
    expect(assembleStream('{"not":"a stream"}')).toBeNull();
  });
});

describe("compactRows", () => {
  test("assembles a stream stored wrapped in a JSON object, which is not flagged as streamed", () => {
    const row = {
      occurred_at: "2026-09-10 12:00:00.000",
      streamed: false,
      attributes: {},
      request_body: "{}",
      response_body: JSON.stringify({ stream: true, content: sse(chunk({ role: "assistant", content: "six" }), chunk({ content: " seven" }), "[DONE]") }),
    };
    const [compacted] = compactRows([row]).rows;
    expect(compacted!.attributes).toEqual({ response_body_format: "assembled_stream" });
    expect(JSON.parse(compacted!.response_body).choices[0].message.content).toBe("six seven");
  });
});

describe("extractBlobs", () => {
  test("replaces a data URL with a day-scoped content-addressed reference, once per blob", () => {
    const base64 = Buffer.from(new Uint8Array(2048).fill(7)).toString("base64");
    const blobs = new Map();
    const body = JSON.stringify({ a: `data:image/png;base64,${base64}`, b: `data:image/png;base64,${base64}`, small: "data:image/png;base64,AAAA" });

    const compacted = JSON.parse(extractBlobs(body, "2026-09-25", blobs));

    const key = `2026-09-25/${new Bun.CryptoHasher("sha256").update(new Uint8Array(2048).fill(7)).digest("hex")}`;
    expect(compacted).toEqual({ a: `blob:image/png;${key}`, b: `blob:image/png;${key}`, small: "data:image/png;base64,AAAA" });
    expect([...blobs.keys()]).toEqual([key]);
  });
});
