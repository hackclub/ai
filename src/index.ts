import { loadEnv } from "./env";
import { log } from "./log";
import { createBackend } from "./server";

/**
 * Standalone API server (no dashboard). The full site runs through the
 * SvelteKit build, which embeds the same backend; see src/hooks.server.ts.
 */
const env = loadEnv();
const backend = createBackend(env);
try {
  await backend.start();
} catch {
  // start() has logged and reported the error. The API is useless without
  // billing reconciliation, so do not listen.
  await backend.shutdown();
  process.exit(1);
}

backend.app.listen({
  port: env.port,
  idleTimeout: 0,
  maxRequestBodySize: env.maxRequestBodyBytes,
});
log.info({ port: env.port }, "gateway listening");

let stopping = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  try {
    // Close the listener first so no new requests arrive while settlements drain.
    backend.app.stop();
    await backend.shutdown();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "shutdown failed");
    process.exit(1);
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
