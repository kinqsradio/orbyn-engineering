import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** A workspace path in the terminal opens as a file preview, whatever the Chat setting says. */

let service: Service;
let projectId = "";

const fresh = async (page: Page, prompt = "[scene:usage] hello") => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Types until the shell answers, since a shell still starting can lose what is typed. */
async function run(page: Page, command: string, output: RegExp): Promise<Locator> {
  const input = page.locator(".terminal-drawer-body .xterm-helper-textarea").first();
  const line = page.locator(".terminal-drawer-body .xterm-rows > div").filter({ hasText: output }).first();
  await expect(async () => {
    await input.focus();
    await page.keyboard.type(command);
    await expect(line).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 25_000 });
  return line;
}

async function clickLine(page: Page, line: Locator, offset: number) {
  const place = await line.boundingBox();
  if (!place) throw new Error("no line");
  const y = place.y + place.height / 2;
  await page.mouse.move(place.x + offset, y);
  await page.mouse.move(place.x + offset + 2, y);
  await expect(page.locator(".terminal-drawer-body .xterm-screen")).toHaveClass(/xterm-cursor-pointer/);
  await page.mouse.click(place.x + offset, y);
}

async function openTerminal(page: Page) {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".terminal-drawer-body .xterm-helper-textarea").first()).toBeVisible();
}

test("an absolute file path in the terminal opens a preview tab", async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 900 });
  // A file link is always in-app, even when addresses go to the system browser.
  await page.addInitScript(() => localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ linkTarget: "external" })));
  await fresh(page);
  const id = threadIdOf(page);
  await settled(service, id);
  const thread = await service.api<{ cwd: string }>("GET", `/api/threads/${id}`);
  const file = join(thread.cwd, "terminal-preview.html");
  writeFileSync(file, "<!doctype html><title>Terminal preview</title><p>from the terminal</p>\n");
  await openTerminal(page);
  const quoted = file.replace(/(["\\$`])/g, "\\$1");
  const line = await run(page, `printf '%s\\n' "${quoted}"\n`, new RegExp(`^${escape(file)}`));
  await clickLine(page, line, 40);
  await expect
    .poll(async () => (await service.api<{ url: string }[]>("GET", `/api/threads/${id}/previews`)).map((tab) => tab.url))
    .toContainEqual(expect.stringMatching(/^file:\/\/.*\/terminal-preview\.html$/));
  await expect(page.getByRole("combobox", { name: "Search or enter URL" })).toHaveValue(/terminal-preview\.html$/);
});

test("a relative file path in the terminal opens a preview tab", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ linkTarget: "external" })));
  await fresh(page);
  const id = threadIdOf(page);
  await settled(service, id);
  const thread = await service.api<{ cwd: string }>("GET", `/api/threads/${id}`);
  writeFileSync(join(thread.cwd, "index.html"), "<!doctype html><title>Relative preview</title><p>relative</p>\n");
  await openTerminal(page);
  const line = await run(page, "printf '%s\\n' ./index.html\n", /^\.\/index\.html/);
  await clickLine(page, line, 4);
  await expect
    .poll(async () => (await service.api<{ url: string }[]>("GET", `/api/threads/${id}/previews`)).map((tab) => tab.url))
    .toContainEqual(expect.stringMatching(/^file:\/\/.*\/index\.html$/));
  await expect(page.getByRole("combobox", { name: "Search or enter URL" })).toHaveValue(/\/index\.html$/);
});

test("a missing file path in the terminal says it could not open", async ({ page }) => {
  await fresh(page);
  const id = threadIdOf(page);
  await settled(service, id);
  await openTerminal(page);
  const line = await run(page, "printf '%s\\n' ./missing.html\n", /^\.\/missing\.html/);
  await clickLine(page, line, 4);
  await expect(page.getByText(/^Couldn't open it\./)).toBeVisible();
  expect(await service.api("GET", `/api/threads/${id}/previews`)).toEqual([]);
});
