import { describe, expect, test } from "bun:test";

import { toClickHouseEvent } from "./request-event-task";

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
