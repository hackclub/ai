export type MemoAsyncOptions = {
  ttlMs: number;
  now?: () => number;
  /** Bound on distinct keys; the oldest entry is evicted past it. */
  maxEntries?: number;
};

/**
 * Per-key async memo: fresh values are served from memory; an expired value
 * is served immediately while one refresh runs in the background
 * (stale-while-revalidate); concurrent misses share one in-flight load; a
 * failed refresh keeps the last value and surfaces the error only when there
 * is nothing to fall back to.
 */
export const memoAsync = <K, V>(load: (key: K) => Promise<V>, options: MemoAsyncOptions) => {
  const now = options.now ?? Date.now;
  const cache = new Map<K, { value: V; fetchedAt: number }>();
  const inFlight = new Map<K, Promise<V>>();
  const refresh = (key: K, fallback: { value: V } | undefined) => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = load(key)
      .then((value) => {
        cache.set(key, { value, fetchedAt: now() });
        if (options.maxEntries && cache.size > options.maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        return value;
      })
      .catch((error: unknown) => {
        if (fallback) return fallback.value;
        throw error;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  };
  return {
    get(key: K): Promise<V> {
      const cached = cache.get(key);
      if (cached && now() - cached.fetchedAt < options.ttlMs) return Promise.resolve(cached.value);
      if (cached) {
        void refresh(key, cached).catch(() => {});
        return Promise.resolve(cached.value);
      }
      return refresh(key, undefined);
    },
    clear: () => cache.clear(),
  };
};
