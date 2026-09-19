import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import {
  drainRequestEvents,
  isClickHouseRejection,
  type RequestEventPayload,
  toClickHouseEvent,
} from "./request-events";

describe("toClickHouseEvent", () => {
  test("maps a finalization payload and defaults malformed fields", () => {
    const row = toClickHouseEvent({
      event_id: "11111111-1111-1111-1111-111111111111",
      occurred_at: "2026-09-17T12:00:00.250Z",
      request_id: "22222222-2222-2222-2222-222222222222",
      account_id: "33333333-3333-3333-3333-333333333333",
      provider: "openrouter",
      streamed: true,
      http_status: "not a number",
      time_to_first_byte_ms: 12,
      request_headers: { "user-agent": "x", nested: { bad: true } },
      billed_cost_usd: "0.000500000000",
    });
    expect(row.occurred_at).toBe("2026-09-17 12:00:00.250");
    expect(row.http_status).toBe(0);
    expect(row.time_to_first_byte_ms).toBe(12);
    expect(row.request_headers).toEqual({ "user-agent": "x" });
    expect(row.outcome).toBe("completed");
    expect(row.provider_cost_usd).toBeNull();
    expect(row.user_id).toBeNull();
  });

  test("refuses a payload without an event id", () => {
    expect(() => toClickHouseEvent({})).toThrow("event_id");
  });
});

describe("drainRequestEvents", () => {
  type Statement = { text: string; values: unknown[] };

  /** A fake `sql` that answers the claim with one row and records every statement. */
  const fakeSql = (
    statements: Statement[],
    claimed: { id: string; payload: RequestEventPayload }[] = [
      { id: "1", payload: { event_id: "11111111-1111-1111-1111-111111111111" } },
    ],
  ) =>
    (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      statements.push({ text, values });
      if (text.includes("SET claimed_at = now()")) return claimed;
      return [];
    }) as unknown as postgres.Sql;

  const clickhouse = (insert: () => Promise<void>) =>
    ({ insert }) as unknown as ClickHouseClient;

  test("claims, inserts, then deletes with no transaction open across the insert", async () => {
    const statements: Statement[] = [];
    let inserted = 0;
    const taken = await drainRequestEvents({
      sql: fakeSql(statements),
      clickhouse: clickhouse(async () => { inserted += 1; }),
    });
    expect(taken).toBe(1);
    expect(inserted).toBe(1);
    expect(statements.map((s) => s.text.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "UPDATE request_event_outbox",
      "DELETE FROM",
    ]);
    expect(statements[1]?.values[0]).toEqual(["1"]);
  });

  test("counts an attempt and releases the claim on any insert failure", async () => {
    for (const error of [new Error("connect ECONNREFUSED"), new ClickHouseError({ message: "Cannot parse", code: "6", type: "CANNOT_PARSE_TEXT" })]) {
      const statements: Statement[] = [];
      await expect(
        drainRequestEvents({ sql: fakeSql(statements), clickhouse: clickhouse(async () => { throw error; }) }),
      ).rejects.toThrow(error.message);
      const release = statements[1];
      expect(release?.text).toContain("attempts = attempts + 1");
      expect(release?.text).toContain("claimed_at = NULL");
      expect(release?.values).toEqual([error.message, ["1"]]);
    }
  });

  test("parks unmappable rows in one statement and still delivers the rest", async () => {
    const statements: Statement[] = [];
    await drainRequestEvents({
      sql: fakeSql(statements, [
        { id: "1", payload: { event_id: "11111111-1111-1111-1111-111111111111" } },
        { id: "2", payload: {} },
      ]),
      clickhouse: clickhouse(async function (this: unknown, ..._args: unknown[]) {} as never),
    });
    const park = statements.find((s) => s.text.includes("unnest("));
    expect(park?.values).toEqual([25, ["2"], ["request event payload has no event_id"]]);
    expect(statements.at(-1)?.text).toContain("DELETE FROM");
  });

  test("isClickHouseRejection distinguishes server rejections", () => {
    expect(isClickHouseRejection(new Error("x"))).toBeFalse();
    expect(isClickHouseRejection(new ClickHouseError({ message: "m", code: "6", type: "T" }))).toBeTrue();
  });
});
