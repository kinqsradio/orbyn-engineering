/** Installs Playwright's headless shell under node_modules, so e2e needs no installed browser. */
import { spawnSync } from "node:child_process";
import process from "node:process";

const { status } = spawnSync("npx", ["playwright", "install", "chromium-headless-shell"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
  shell: process.platform === "win32",
  stdio: "inherit",
});
process.exit(status ?? 1);
