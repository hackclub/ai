import { expect, test } from "bun:test";

import { type ServerSentEvent, ServerSentEventParser } from "./sse-parser";

const parse = (chunks: Uint8Array[]) => {
  const events: ServerSentEvent[] = [];
  const parser = new ServerSentEventParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  parser.finish();
  return events;
};

test("parses events across arbitrary byte and CRLF boundaries", () => {
  const bytes = new TextEncoder().encode(
    "﻿: keepalive\r\nevent: response.completed\r\n" +
      "id: generation-1\r\ndata: first\r\ndata: second\r\nretry: 2500\r\n\r\n" +
      "data: [DONE]\n\n",
  );
  expect(parse([...bytes].map((byte) => Uint8Array.of(byte)))).toEqual([
    { data: "first\nsecond", event: "response.completed", id: "generation-1", retry: 2500 },
    { data: "[DONE]", event: "message", id: "generation-1", retry: null },
  ]);
});

test("dispatches a final unterminated event and ignores invalid fields", () => {
  const bytes = new TextEncoder().encode("retry: nope\nid: ignored\0id\ndata: final event without newline");
  expect(parse([bytes])).toEqual([{ data: "final event without newline", event: "message", id: "", retry: null }]);
});
