import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  },
});
