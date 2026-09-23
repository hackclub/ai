import { expect, test } from "bun:test";

import { memoAsync } from "./memo-async";

/** A memo over `key-<call number>` with a controllable clock; `failOn` makes that call throw. */
const counter = (options: { maxEntries?: number; failOn?: number } = {}) => {
  const clock = { now: 0 };
  let calls = 0;
  const memo = memoAsync(
    async (key: string) => {
      calls += 1;
      if (calls === options.failOn) throw new Error("boom");
      return `${key}-${calls}`;
    },
    { ttlMs: 1_000, now: () => clock.now, maxEntries: options.maxEntries },
  );
  return { memo, clock, calls: () => calls };
};

/** Lets a background refresh settle. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("serves a fresh value without issuing a load", async () => {
  const { memo, clock, calls } = counter();
  expect(await memo.get("a")).toBe("a-1");
  clock.now = 999;
  expect(await memo.get("a")).toBe("a-1");
  expect(calls()).toBe(1);
});

test("shares one in-flight load between concurrent misses", async () => {
  const { memo, calls } = counter();
  const [a, b] = await Promise.all([memo.get("a"), memo.get("a")]);
  expect(a).toBe(b);
  expect(calls()).toBe(1);
});

test("returns a stale value immediately and refreshes it in the background", async () => {
  const { memo, clock, calls } = counter();
  await memo.get("a");
  clock.now = 1_000;
  expect(await memo.get("a")).toBe("a-1");
  expect(calls()).toBe(2);
  await flush();
  expect(await memo.get("a")).toBe("a-2");
});

test("keeps the cached value when a background refresh fails", async () => {
  const { memo, clock } = counter({ failOn: 2 });
  await memo.get("a");
  clock.now = 1_000;
  expect(await memo.get("a")).toBe("a-1");
  await flush();
  expect(await memo.get("a")).toBe("a-1");
});

test("rejects a failed first load with no fallback to serve", async () => {
  const { memo } = counter({ failOn: 1 });
  await expect(memo.get("a")).rejects.toThrow("boom");
});

test("evicts the oldest entry past maxEntries", async () => {
  const { memo, calls } = counter({ maxEntries: 2 });
  for (const key of ["a", "b", "c", "a"]) await memo.get(key);
  expect(calls()).toBe(4);
});
