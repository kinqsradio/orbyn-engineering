import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { openDetails, send, settled, startProject, threadIdOf, type Service } from "./service";

/** The favorite editor is the first launchable one, and its shortcut opens it. */

let service: Service;
let projectId = "";
let dir = "";
let marker = "";
let oldPath = "";

/** A `code` on PATH that records its arguments, so no real editor is needed. */
function stubEditor(): void {
  if (process.platform === "win32") {
    writeFileSync(join(dir, "code.cmd"), `@echo %* > "${marker}"\r\n`);
    return;
  }
  writeFileSync(join(dir, "code"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\n`, { mode: 0o755 });
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "orbyn-editor-"));
  marker = join(dir, "launch.log");
  stubEditor();
  oldPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}${delimiter}${oldPath}`;
  try {
    ({ service, projectId } = await startProject({ fakeEngines: true }));
  } finally {
    process.env.PATH = oldPath;
  }
});

test.afterAll(async () => {
  await service.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the details card opens the favorite editor and shows its shortcut", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "hello");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);

  const details = await openDetails(page);
  await expect(details.getByRole("button", { name: "Open in VS Code" })).toBeVisible();

  await details.getByRole("button", { name: "Choose editor" }).click();
  const menu = page.getByRole("menu", { name: "Open in" });
  const shortcut = process.platform === "darwin" ? "⌘O" : "Ctrl+O";
  await expect(menu.getByRole("menuitem", { name: /VS Code/ })).toContainText(shortcut);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+o");
  const thread = await service.api<{ cwd: string }>("GET", `/api/threads/${id}`);
  await expect.poll(() => (existsSync(marker) ? readFileSync(marker, "utf8") : "")).toContain(thread.cwd);
});
