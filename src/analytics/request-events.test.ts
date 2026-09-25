import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

import { testBlobStore } from "../test/database";
import { drainRequestEvents } from "./request-events";

const blobStore = await testBlobStore();

describe("drainRequestEvents", () => {
  type Statement = { text: string; values: unknown[] };
  const VALID = { id: "1", payload: { event_id: "11111111-1111-1111-1111-111111111111" } };

  /** A fake `sql` that answers the claim with `claimed` and records every statement. */
  const drain = (
    insert: () => Promise<void>,
    claimed: { id: string; payload: unknown }[] = [VALID],
  ) => {
    const statements: Statement[] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      statements.push({ text, values });
      return text.includes("SET claimed_at = now()") ? claimed : [];
    }) as unknown as postgres.Sql;
    const clickhouse = { insert } as unknown as ClickHouseClient;
    return { statements, result: drainRequestEvents({ sql, clickhouse, blobStore }) };
  };

  test("claims, inserts, then deletes with no transaction open across the insert", async () => {
    let inserted = 0;
    const { statements, result } = drain(async () => {
      inserted += 1;
    });
    expect(await result).toBe(1);
    expect(inserted).toBe(1);
    expect(statements.map((s) => s.text.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "UPDATE request_event_outbox",
      "DELETE FROM",
    ]);
    expect(statements[1]?.values[0]).toEqual(["1"]);
  });

  test("counts an attempt and releases the claim when the insert fails", async () => {
    const { statements, result } = drain(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(result).rejects.toThrow("connect ECONNREFUSED");
    const release = statements[1];
    expect(release?.text).toContain("attempts = attempts + 1");
    expect(release?.text).toContain("claimed_at = NULL");
    expect(release?.values).toEqual(["connect ECONNREFUSED", ["1"]]);
  });

  test("parks unmappable rows in one statement and still delivers the rest", async () => {
    const { statements, result } = drain(async () => {}, [VALID, { id: "2", payload: {} }]);
    await result;
    const park = statements.find((s) => s.text.includes("unnest("));
    expect(park?.values).toEqual([25, ["2"], ["request event payload has no event_id"]]);
    expect(statements.at(-1)?.text).toContain("DELETE FROM");
  });
});
