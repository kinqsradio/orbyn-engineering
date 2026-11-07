import { expect, test } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryReady, openPanelTab, startService, type Service } from "./service";

/**
 * F66: a Jujutsu checkout with no Git of its own shows its change and diff. A
 * stand-in `jj` answers, so this proves the service and panel, not jj itself.
 */

const STAND_IN = `
const args = process.argv.slice(2);
if (args.includes("log")) process.stdout.write("kxqpmzwt\\n3f2a9c1b\\nfeature\\n0\\nTeach the parser\\n");
else if (args.includes("diff")) process.stdout.write([
  "diff --git a/src/parse.rs b/src/parse.rs", "index 1111111..2222222 100644",
  "--- a/src/parse.rs", "+++ b/src/parse.rs", "@@ -1 +1 @@", "-fn old() {}", "+fn new() {}", "",
].join("\\n"));
else process.exit(2);
`;

let service: Service;
let bin = "";

test.beforeAll(async () => {
  bin = mkdtempSync(join(tmpdir(), "orbyn-jj-"));
  writeFileSync(join(bin, "jj.cjs"), STAND_IN);
  writeFileSync(join(bin, "jj.cmd"), '@node "%~dp0\\jj.cjs" %*\r\n');
  writeFileSync(join(bin, "jj"), '#!/bin/sh\nexec node "$(dirname "$0")/jj.cjs" "$@"\n');
  chmodSync(join(bin, "jj"), 0o755);
  service = await startService({ path: [bin] });
  await libraryReady(service);
});
test.afterAll(async () => {
  await service.stop();
  rmSync(bin, { recursive: true, force: true });
});

test("a jj checkout shows its working-copy change and diff in the changes panel", async ({ page }) => {
  mkdirSync(join(service.folder, ".jj", "repo"), { recursive: true });
  const project = await service.api<{ id: string }>("POST", "/api/projects/add", { path: service.folder });
  await service.api("POST", `/api/projects/${project.id}/trust`);
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: project.id, engine: engines[0]?.id, model: null, title: "jj", worktree: null, skill_profile: null,
  });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await openPanelTab(page, "Diff");
  const change = page.getByRole("note", { name: "Jujutsu change" });
  await expect(change).toContainText("jj change kxqpmzwt");
  await expect(change).toContainText("on feature");
  await expect(change).toContainText("Teach the parser");
  await expect(page.locator("[data-diff-file='src/parse.rs'] .diff-status")).toHaveText("M");
});
