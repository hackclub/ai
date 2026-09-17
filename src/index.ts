import { loadEnv } from "./env";
import { createBackend } from "./server";

/**
 * Standalone API server (no dashboard). The full site runs through the
 * SvelteKit build, which embeds the same backend; see src/hooks.server.ts.
 */
const env = loadEnv();
const backend = createBackend(env);
await backend.start();

backend.app.listen({ port: env.port, idleTimeout: 0 });
console.log(`Hack Club AI gateway listening on http://localhost:${env.port}`);

const shutdown = async () => {
  backend.app.stop();
  await backend.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
