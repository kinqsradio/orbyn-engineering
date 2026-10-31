import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { mockApi } from "./mock/plugin.ts";

/**
 * `npm run dev` serves the deterministic mock API. Set ORBYN_API to a running
 * orbynd origin to proxy to the real service instead. The mock is a dev-server
 * plugin outside `src`, so no application module can import it into a build;
 * scripts/assert-no-mock.mjs checks the output of every production build.
 */
const realApi = process.env.ORBYN_API;

export default defineConfig({
  plugins: [react(), ...(realApi ? [] : [mockApi()])],
  server: {
    port: 5273,
    strictPort: false,
    proxy: realApi
      ? {
          "/api": realApi,
          "/auth": realApi,
          "/ws": { target: realApi, ws: true },
        }
      : undefined,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "mock/**/*.test.ts"],
    css: false,
  },
});
