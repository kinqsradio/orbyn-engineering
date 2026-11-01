// Starts the staged release service and checks that it serves the API and UI.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaries = join(root, "desktop/src-tauri/binaries");
const binary = join(binaries, readdirSync(binaries).find((f) => f.startsWith("orbynd-")));
const data = mkdtempSync(join(tmpdir(), "orbyn-smoke-"));
const service = spawn(
  binary,
  [
    "serve",
    "--data-dir",
    data,
    "--ui-dir",
    join(root, "build/ui"),
    "--library-bundle",
    join(root, "build/library"),
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);

const timeout = setTimeout(() => {
  service.kill();
  throw new Error("Service did not report ready.");
}, 20_000);

const line = await new Promise((done) => createInterface({ input: service.stdout }).once("line", done));
clearTimeout(timeout);
const { url, token } = JSON.parse(line);
try {
  const denied = await fetch(new URL("/api/info", url));
  if (denied.status !== 401) throw new Error(`Expected 401 without token, got ${denied.status}`);
  const info = await fetch(new URL("/api/info", url), { headers: { Authorization: `Bearer ${token}` } });
  if (!info.ok) throw new Error(`/api/info failed: ${info.status}`);
  const page = await fetch(url);
  if (!page.ok || !(await page.text()).includes("<div")) throw new Error("UI was not served.");
  console.log("Package smoke passed:", await info.json());
} finally {
  service.kill();
  // A git the service started can outlive it, and Windows then holds its folder. This
  // is a temp folder, so a leftover there is no reason to fail a package that passed.
  try {
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.warn(`Left ${data} behind: ${error.code}`);
  }
}
