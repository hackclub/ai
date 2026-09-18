import * as Sentry from "@sentry/bun";

import { log } from "./log";
import type { Backend } from "./server";

/**
 * Shared process lifecycle for the two entrypoints (src/index.ts and the
 * SvelteKit hook). `startBackend` never throws: a failure is recorded so the
 * health check can report it, logged, and sent to Sentry. The caller decides
 * whether that is fatal (standalone API: yes; SvelteKit site: no, keep
 * serving pages but answer 503 on /up).
 */
export type Lifecycle = {
  started: Promise<void>;
  startupError: () => Error | null;
};

export const startBackend = (backend: Backend): Lifecycle => {
  const started = backend.start().catch((error: unknown) => {
    const startupError = error instanceof Error ? error : new Error(String(error));
    backend.setStartupError(startupError);
    log.error("backend start failed", { error: startupError });
    Sentry.captureException(startupError, { tags: { stage: "startup" } });
  });
  return { started, startupError: backend.startupError };
};

/**
 * Registers SIGINT/SIGTERM once per process. `stopServer` closes the HTTP
 * listener first so no new requests arrive while the worker drains.
 */
export const installShutdownHandlers = (
  backend: Backend,
  options: { stopServer?: () => void } = {},
) => {
  const registry = globalThis as typeof globalThis & { __hcaiShutdownInstalled?: boolean };
  if (registry.__hcaiShutdownInstalled) return;
  registry.__hcaiShutdownInstalled = true;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    try {
      options.stopServer?.();
      await backend.shutdown();
    } catch (error) {
      log.error("shutdown failed", { error });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};
