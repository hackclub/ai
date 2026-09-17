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
        adapter: adapter({ serverOptions: { idleTimeout: 0 } }),
        // The proxy API is called by SDKs with no Origin header and includes a
        // multipart upload, so SvelteKit's global check cannot apply to it.
        // src/hooks.server.ts re-applies the same-origin rule to page routes,
        // and dashboard mutations use JSON bodies with SameSite=Lax cookies.
        csrf: { trustedOrigins: ["*"] },
      }),
    ],
  };
});
