import { describe, expect, test } from "bun:test";

import {
  type ServerSentEvent,
  ServerSentEventParser,
} from "./sse-parser";

const encoder = new TextEncoder();

describe("ServerSentEventParser", () => {
  test("parses events across arbitrary byte and CRLF boundaries", () => {
    const events: ServerSentEvent[] = [];
    const parser = new ServerSentEventParser((event) => events.push(event));
    const bytes = encoder.encode(
      "\uFEFF: keepalive\r\nevent: response.completed\r\n" +
        "id: generation-1\r\ndata: first\r\ndata: second\r\nretry: 2500\r\n\r\n" +
        "data: [DONE]\n\n",
    );

    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    parser.finish();

    expect(events).toEqual([
      {
        data: "first\nsecond",
        event: "response.completed",
        id: "generation-1",
        retry: 2500,
      },
      {
        data: "[DONE]",
        event: "message",
        id: "generation-1",
        retry: null,
      },
    ]);
  });

  test("dispatches a final unterminated event and ignores invalid fields", () => {
    const events: ServerSentEvent[] = [];
    const parser = new ServerSentEventParser((event) => events.push(event));

    parser.push(
      encoder.encode(
        "retry: nope\nid: ignored\0id\ndata: final event without newline",
      ),
    );
    parser.finish();

    expect(events).toEqual([
      {
        data: "final event without newline",
        event: "message",
        id: "",
        retry: null,
      },
    ]);
  });
});
