import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import { drainRequestEvents, isClickHouseRejection, toClickHouseEvent } from "./request-events";

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

describe("drainRequestEvents attempt accounting", () => {
  type Update = { attemptsDelta: unknown; error: unknown };

  /** A fake `sql` whose transaction hands back one row and records the release update. */
  const fakeSql = (updates: Update[]) => {
    const tx = Object.assign(
      async (strings: TemplateStringsArray) => {
        if (strings.join("?").includes("SELECT id::text")) {
          return [{ id: "1", payload: { event_id: "11111111-1111-1111-1111-111111111111" } }];
        }
        return [];
      },
      {},
    );
    const sql = Object.assign(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        updates.push({ attemptsDelta: values[0], error: values[1] });
        return [];
      },
      { begin: (run: (tx: unknown) => Promise<unknown>) => run(tx) },
    );
    return sql as unknown as postgres.Sql;
  };

  const clickhouseThrowing = (error: Error) =>
    ({ insert: async () => { throw error; } }) as unknown as ClickHouseClient;

  test("does not spend a row's attempt budget when ClickHouse is unreachable", async () => {
    const updates: Update[] = [];
    await expect(
      drainRequestEvents({
        sql: fakeSql(updates),
        clickhouse: clickhouseThrowing(new Error("connect ECONNREFUSED")),
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(updates).toEqual([{ attemptsDelta: 0, error: "connect ECONNREFUSED" }]);
    expect(isClickHouseRejection(new Error("x"))).toBeFalse();
  });

  test("counts an attempt when ClickHouse itself rejects the batch", async () => {
    const updates: Update[] = [];
    const rejection = new ClickHouseError({ message: "Cannot parse", code: "6", type: "CANNOT_PARSE_TEXT" });
    await expect(
      drainRequestEvents({ sql: fakeSql(updates), clickhouse: clickhouseThrowing(rejection) }),
    ).rejects.toThrow("Cannot parse");
    expect(updates[0]?.attemptsDelta).toBe(1);
    expect(isClickHouseRejection(rejection)).toBeTrue();
  });
});
