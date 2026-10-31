import { defineConfig, devices } from "@playwright/test";

/** Runs against the dev server's deterministic mock API; `e2e/real` starts the real service. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:5274",
    ...devices["Desktop Chrome"],
    channel: "chrome",
  },
  webServer: {
    command: "npx vite --port 5274 --strictPort",
    url: "http://localhost:5274",
    reuseExistingServer: false,
  },
});
