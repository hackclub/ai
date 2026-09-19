import { describe, expect, test } from "bun:test";

import { memoAsync } from "./memo-async";

describe("memoAsync", () => {
  test("serves a fresh value without issuing a load", async () => {
    const clock = { now: 0 };
    let calls = 0;
    const memo = memoAsync(
      async (key: string) => {
        calls += 1;
        return `${key}-${calls}`;
      },
      { ttlMs: 1_000, now: () => clock.now },
    );
    expect(await memo.get("a")).toBe("a-1");
    clock.now = 999;
    expect(await memo.get("a")).toBe("a-1");
    expect(calls).toBe(1);
  });

  test("shares one in-flight load between concurrent misses", async () => {
    let calls = 0;
    const memo = memoAsync(
      async (key: string) => {
        calls += 1;
        return `${key}-${calls}`;
      },
      { ttlMs: 1_000 },
    );
    const [a, b] = await Promise.all([memo.get("a"), memo.get("a")]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  test("returns a stale value immediately and refreshes it in the background", async () => {
    const clock = { now: 0 };
    let calls = 0;
    const memo = memoAsync(
      async (key: string) => {
        calls += 1;
        return `${key}-${calls}`;
      },
      { ttlMs: 1_000, now: () => clock.now },
    );
    expect(await memo.get("a")).toBe("a-1");
    clock.now = 1_000;
    expect(await memo.get("a")).toBe("a-1");
    expect(calls).toBe(2);
    // Let the background refresh settle before checking the next call.
    await Promise.resolve();
    await Promise.resolve();
    expect(await memo.get("a")).toBe("a-2");
  });

  test("keeps the cached value when a background refresh fails", async () => {
    const clock = { now: 0 };
    let calls = 0;
    const memo = memoAsync(
      async (key: string) => {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        return `${key}-${calls}`;
      },
      { ttlMs: 1_000, now: () => clock.now },
    );
    expect(await memo.get("a")).toBe("a-1");
    clock.now = 1_000;
    expect(await memo.get("a")).toBe("a-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(await memo.get("a")).toBe("a-1");
  });

  test("rejects a failed first load with no fallback to serve", async () => {
    const memo = memoAsync(
      async () => {
        throw new Error("boom");
      },
      { ttlMs: 1_000 },
    );
    await expect(memo.get("a")).rejects.toThrow("boom");
  });

  test("evicts the oldest entry past maxEntries", async () => {
    let calls = 0;
    const memo = memoAsync(
      async (key: string) => {
        calls += 1;
        return `${key}-${calls}`;
      },
      { ttlMs: 1_000, maxEntries: 2 },
    );
    await memo.get("a");
    await memo.get("b");
    await memo.get("c");
    // "a" was evicted, so fetching it again issues a new load.
    await memo.get("a");
    expect(calls).toBe(4);
  });
});
