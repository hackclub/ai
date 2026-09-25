import { expect, test } from "bun:test";

import { testBlobStore, testClickHouse, testDatabase } from "../src/test/database";
import { compactStoredBodies } from "./compact-bodies";

await testDatabase();
const { clickhouse } = await testClickHouse();
const blobStore = await testBlobStore();

test("rewrites raw SSE and inline images as a new version and leaves the rest alone", async () => {
  const streamed = crypto.randomUUID();
  const withImage = crypto.randomUUID();
  const plain = crypto.randomUUID();
  const day = new Date().toISOString().slice(0, 10);
  const image = crypto.getRandomValues(new Uint8Array(4096));
  const row = (eventId: string, extra: object) => ({
    event_id: eventId,
    occurred_at: `${day} 10:00:00.000`,
    request_id: crypto.randomUUID(),
    account_id: crypto.randomUUID(),
    endpoint: "chat/completions",
    billed_cost_usd: "0.000000000123",
    request_body: '{"messages":[]}',
    ...extra,
  });
  const delta = (content: string) => `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: { content } }] })}\n\n`;
  await clickhouse.insert({
    table: "request_events",
    values: [
      row(streamed, { streamed: true, attributes: { body_capture: "complete" }, response_body: `${delta("six")}${delta(" seven")}` }),
      row(withImage, {
        request_body: JSON.stringify({ image: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}` }),
        response_body: '{"choices":[]}',
      }),
      row(plain, { response_body: '{"choices":[]}' }),
    ],
    format: "JSONEachRow",
  });

  expect(await compactStoredBodies({ clickhouse, blobStore, log: () => {} })).toMatchObject({ rows: 2, rewritten: 2, blobs: 1 });
  expect(await compactStoredBodies({ clickhouse, blobStore, log: () => {} })).toMatchObject({ rows: 0 });

  const result = await clickhouse.query({
    query: `
      SELECT event_id, event_version, billed_cost_usd, attributes, request_body, response_body
      FROM request_events FINAL WHERE event_id IN ({ids:Array(UUID)})
    `,
    query_params: { ids: [streamed, withImage, plain] },
    format: "JSONEachRow",
    clickhouse_settings: { output_format_json_quote_decimals: 1 },
  });
  const rows = Object.fromEntries((await result.json<Record<string, unknown>>()).map((r) => [r.event_id, r]));
  expect(rows[streamed]).toMatchObject({
    event_version: 2,
    billed_cost_usd: "0.000000000123",
    attributes: { body_capture: "complete", response_body_format: "assembled_stream" },
  });
  expect(JSON.parse(rows[streamed]!.response_body as string).choices[0].message.content).toBe("six seven");
  const key = `${day}/${new Bun.CryptoHasher("sha256").update(image).digest("hex")}`;
  expect(rows[withImage]).toMatchObject({ event_version: 2, request_body: JSON.stringify({ image: `blob:image/jpeg;${key}` }) });
  expect(new Uint8Array(await blobStore.file(key).arrayBuffer())).toEqual(image);
  expect(rows[plain]).toMatchObject({ event_version: 1, response_body: '{"choices":[]}' });
});
