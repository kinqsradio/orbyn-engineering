// Starts the staged release service and checks that it serves the API and UI.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { smokeService } from "./smoke-service.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaries = join(root, "desktop/src-tauri/binaries");
const binary = join(binaries, readdirSync(binaries).find((f) => f.startsWith("orbynd-")));
const data = mkdtempSync(join(tmpdir(), "orbyn-smoke-"));
const info = await smokeService(
  binary,
  [
    "serve",
    "--parent-stdin",
    "--data-dir",
    data,
    "--ui-dir",
    join(root, "build/ui"),
    "--library-bundle",
    join(root, "build/library"),
  ],
  data,
  async ({ url, token }) => {
    const denied = await fetch(new URL("/api/info", url), { signal: AbortSignal.timeout(20_000) });
    if (denied.status !== 401) throw new Error(`Expected 401 without token, got ${denied.status}`);
    const info = await fetch(new URL("/api/info", url), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!info.ok) throw new Error(`/api/info failed: ${info.status}`);
    const page = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!page.ok || !(await page.text()).includes("<div")) throw new Error("UI was not served.");
    return info.json();
  },
);
console.log("Package smoke passed:", info);
