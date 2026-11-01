import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Default rules from the real service reach the surface that owns each command. */

let service: Service;
let projectId = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
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

test("composer keys open the model picker, effort and the branch switcher", async ({ page }) => {
  await fresh(page);
  await settled(service, threadIdOf(page));
  await box(page).press("ControlOrMeta+Shift+m");
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await expect(picker).toBeVisible();
  await picker.getByRole("textbox", { name: "Search models" }).press("ArrowLeft");
  await expect(picker.locator(".model-tab:focus")).toBeVisible();
  await page.keyboard.press("Escape");
  await box(page).press("ControlOrMeta+Shift+e");
  await expect(page.getByRole("menu", { name: "Composer options" })).toBeVisible();
  await page.keyboard.press("Escape");
  await box(page).press("ControlOrMeta+Shift+g");
  await expect(page.getByRole("dialog", { name: "Switch branch" })).toBeVisible();
});

test("alt+up takes the last queued message back, and terminal keys split and close", async ({ page }) => {
  await fresh(page, "[hang]");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await service.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${threadIdOf(page)}`)).active_run?.state).toBe("running");
  await box(page).fill("come back");
  await box(page).press("Enter");
  await expect(page.getByLabel("Queued messages").getByText("come back")).toBeVisible();
  await expect(box(page)).toHaveValue("");
  await box(page).press("Alt+ArrowUp");
  await expect(box(page)).toHaveValue("come back");
  await box(page).fill("");
  await page.getByRole("button", { name: "Stop" }).click();
  await settled(service, threadIdOf(page));

  await page.getByRole("button", { name: "Terminal" }).click();
  await page.locator(".terminal-drawer-body .xterm-helper-textarea").first().focus();
  await page.keyboard.press("ControlOrMeta+n");
  await expect.poll(async () => (await service.api<unknown[]>("GET", `/api/threads/${threadIdOf(page)}/terminals`)).length).toBeGreaterThan(1);
  // The new tab's terminal loads after its row appears, and takes focus when it does.
  await expect(async () => {
    await page.locator(".terminal-splits .xterm-helper-textarea").first().focus();
    await expect(page.locator(".terminal-splits .xterm-helper-textarea").first()).toBeFocused({ timeout: 500 });
    await page.keyboard.press("ControlOrMeta+d");
    await expect(page.locator(".terminal-splits .xterm")).toHaveCount(2, { timeout: 1000 });
  }).toPass();
});

test("Shift+PageUp reads scrollback without leaving the terminal", async ({ page }) => {
  await fresh(page);
  await settled(service, threadIdOf(page));
  await page.getByRole("button", { name: "Terminal" }).click();
  const input = page.locator(".terminal-drawer-body .xterm-helper-textarea").first();
  const rows = page.locator(".terminal-drawer-body .xterm-rows").first();
  // A shell still starting can lose what is typed, so this tries again until it answers.
  await expect(async () => {
    await input.focus();
    await page.keyboard.type("for i in $(seq 1 300); do echo line$i; done\n");
    await expect(rows).toContainText("line300", { timeout: 4000 });
  }).toPass({ timeout: 25_000 });
  await input.focus();
  await page.keyboard.press("Shift+PageUp");
  await expect(rows).not.toContainText("line300");
  await page.keyboard.press("Shift+PageDown");
  await expect(rows).toContainText("line300");
});

test("an address in the terminal opens in the Browser panel", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ linkTarget: "in-app" })));
  await fresh(page);
  await settled(service, threadIdOf(page));
  await page.getByRole("button", { name: "Terminal" }).click();
  const input = page.locator(".terminal-drawer-body .xterm-helper-textarea").first();
  const line = page.locator(".terminal-drawer-body .xterm-rows > div").filter({ hasText: /^http:\/\/localhost:1\/x/ }).first();
  // A shell still starting can lose what is typed, so this tries again until it answers.
  await expect(async () => {
    await input.focus();
    await page.keyboard.type("printf 'http://%s\\n' localhost:1/x\n");
    await expect(line).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 25_000 });
  const place = await line.boundingBox();
  if (!place) throw new Error("no line");
  await page.mouse.move(place.x + 40, place.y + place.height / 2);
  await page.mouse.move(place.x + 44, place.y + place.height / 2);
  await expect(page.locator(".terminal-drawer-body .xterm-screen")).toHaveClass(/xterm-cursor-pointer/);
  await page.mouse.click(place.x + 44, place.y + place.height / 2);
  await expect(page.getByRole("combobox", { name: "Search or enter URL" })).toHaveValue(/localhost:1\/x/);
});

test("F6 walks the window's areas", async ({ page }) => {
  await fresh(page);
  await settled(service, threadIdOf(page));
  await box(page).focus();
  await page.keyboard.press("F6");
  await expect(box(page)).not.toBeFocused();
  await page.keyboard.press("Shift+F6");
  await expect(box(page)).toBeFocused();
});

test("usage period keys come from the rules", async ({ page }) => {
  await page.goto(`${service.page}#/usage`);
  const usage = page.getByRole("dialog", { name: "Usage" });
  await expect(usage).toBeVisible();
  // The rules arrive just after the page does.
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+Shift+2");
    await expect(usage.getByRole("radio", { name: "7 days" })).toBeChecked({ timeout: 500 });
  }).toPass();
  await page.keyboard.press("ControlOrMeta+Shift+4");
  await expect(usage.getByRole("radio", { name: "90 days" })).toBeChecked();
});

test("a keybindings file that changes or breaks says so when you come back", async ({ page }) => {
  // The toast compares with what the page already read, so the first read has to land.
  const read = page.waitForResponse((response) => response.url().endsWith("/api/keybindings"));
  await page.goto(service.page);
  await read;
  const view = await service.api<{ path: string }>("GET", "/api/keybindings");
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  writeFileSync(view.path, JSON.stringify([{ key: "mod+shift+y", command: "sidebar.toggle" }]));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Keybindings reloaded")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+y");
  await expect(page.getByRole("button", { name: "Expand sidebar" }).or(page.locator(".sidebar[data-collapsed]")).first()).toBeVisible();
  writeFileSync(view.path, "{ not json");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(/The keybindings file has a problem/)).toBeVisible();
  expect(readFileSync(view.path, "utf8")).toBe("{ not json");
});
