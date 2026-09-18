import { loadEnv } from "./env";
import { installShutdownHandlers, startBackend } from "./lifecycle";
import { createBackend } from "./server";

/**
 * Standalone API server (no dashboard). The full site runs through the
 * SvelteKit build, which embeds the same backend; see src/hooks.server.ts.
 */
const env = loadEnv();
const backend = createBackend(env);
await startBackend(backend).started;
const failure = backend.startupError();
if (failure) {
  // The API is useless without billing reconciliation; do not listen.
  await backend.shutdown();
  process.exit(1);
}

backend.app.listen({ port: env.port, idleTimeout: 0 });
console.log(`Hack Club AI gateway listening on http://localhost:${env.port}`);
installShutdownHandlers(backend, { stopServer: () => backend.app.stop() });
