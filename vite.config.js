import adapter from "@sveltejs/adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Make every .env variable (not only VITE_*) visible to the server hook in
  // dev. The built server runs under Bun, which loads .env itself.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

  return {
    plugins: [
      tailwindcss(),
      sveltekit({
        adapter: adapter({
          serverOptions: {
            idleTimeout: 0,
            // Build-time default; BODY_SIZE_LIMIT overrides at runtime. Keep in
            // step with MAX_REQUEST_BODY_BYTES in src/env.ts.
            maxRequestBodySize: 20 * 1024 * 1024,
          },
        }),
        // SvelteKit's global same-origin check is disabled because SDK clients
        // call /proxy with no Origin header (and with multipart uploads).
        // Cookie-authenticated Elysia routes (/api/keys*, /api/dismiss-agent-banner,
        // /auth/logout) enforce their own origin check via
        // src/gateway/origin-check.ts; src/hooks.server.ts covers page routes.
        // Bearer-key and signature-verified routes are intentionally exempt.
        csrf: { trustedOrigins: ["*"] },
      }),
    ],
  };
});
