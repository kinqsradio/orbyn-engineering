import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Settings rows and the remaining shortcuts, through the real service. */

let service: Service;
let projectId = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const fresh = async (page: Page, prompt = "[scene:usage] hello") => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  return threadIdOf(page);
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("Maintenance keeps diagnostics without a Network inventory", async ({ page }) => {
  await page.goto(`${service.page}#/settings/maintenance`);
  await expect(settings(page).getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(settings(page).getByRole("heading", { name: "Network", exact: true })).toHaveCount(0);
});

test("About folds its open source list, and Worktrees folds branch names", async ({ page }) => {
  await page.goto(`${service.page}#/settings/about`);
  await expect(settings(page).getByText("zustand")).toBeHidden();
  await settings(page).getByRole("button", { name: "Advanced" }).click();
  await expect(settings(page).getByText("zustand")).toBeVisible();
  await expect(settings(page).getByText("axum", { exact: true })).toBeVisible();
  await page.goto(`${service.page}#/settings/worktrees`);
  await expect(settings(page).getByLabel("Naming")).toBeHidden();
  await settings(page).getByRole("button", { name: "Advanced" }).click();
  await expect(settings(page).getByLabel("Naming")).toBeVisible();
});

test("Labs turns Plan off, and Shift+Tab flips it while it is on", async ({ page }) => {
  const id = await fresh(page);
  await settled(service, id);
  await box(page).focus();
  await page.keyboard.press("Shift+Tab");
  // The key flips what the composer shows, so the next press waits for it to show.
  await expect(page.getByRole("button", { name: "Plan", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(async () => (await service.api<{ lifecycle: { plan_mode: boolean } }>("GET", `/api/threads/${id}`)).lifecycle.plan_mode).toBe(false);
  await page.goto(`${service.page}#/settings/labs`);
  await settings(page).getByRole("switch", { name: "Plan mode" }).click();
  await page.goto(`${service.page}#/threads/${id}`);
  await expect(page.getByRole("button", { name: "Plan", exact: true })).toBeHidden();
  await page.goto(`${service.page}#/settings/labs`);
  await settings(page).getByRole("switch", { name: "Plan mode" }).click();
});

test("the worktree location decides where a new worktree goes", async ({ page }) => {
  const location = join(service.dataDir, "elsewhere");
  await page.goto(`${service.page}#/settings/worktrees`);
  const field = settings(page).getByLabel("Worktree location");
  await field.fill(location);
  await field.blur();
  await expect.poll(async () => JSON.stringify(await service.api("GET", "/api/preferences"))).toContain("elsewhere");
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const made = await service.api<{ cwd: string }>("POST", "/api/threads", { project_id: projectId, engine: engines[0]?.id, model: null, title: "Placed", worktree: "placed", skill_profile: null });
  expect(made.cwd.startsWith(location)).toBe(true);
  await service.api("PUT", "/api/preferences", { values: { worktree_location: "" } });
});

test("theme keys cycle the appearance and open the theme settings", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await expect(box(page)).toBeVisible();
  await expect(async () => {
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press("ControlOrMeta+Alt+Shift+a");
    await page.keyboard.press("ControlOrMeta+Alt+Shift+a");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 500 }).not.toBe(before);
  }).toPass();
  await page.keyboard.press("ControlOrMeta+Alt+a");
  await expect(page).toHaveURL(/settings\/appearance/);
});

test("a user's rules reach effort steps and the stop command", async ({ page }) => {
  const id = await fresh(page);
  await settled(service, id);
  const file = join(service.dataDir, "keybindings.json");
  writeFileSync(
    file,
    JSON.stringify([
      { key: "mod+shift+y", command: "composer.increaseEffort" },
      { key: "mod+shift+u", command: "composer.decreaseEffort" },
      { key: "mod+shift+o", command: "thread.stop" },
    ]),
  );
  await page.reload();
  await expect(box(page)).toBeVisible();
  const effort = async () => (await service.api<{ effort?: string }>("GET", `/api/threads/${id}`)).effort;
  await box(page).focus();
  await page.waitForTimeout(500);
  // The composer steps from what it shows, so each press waits for the last to land.
  const shown = page.locator("[data-effort-trigger]");
  const start = (await shown.textContent()) ?? "";
  await page.keyboard.press("ControlOrMeta+Shift+y");
  await expect.poll(effort).toBe("xhigh");
  await expect(shown).not.toHaveText(start);
  await page.keyboard.press("ControlOrMeta+Shift+y");
  await expect.poll(effort).toBe("medium");
  await expect(shown).toHaveText(start);
  await page.keyboard.press("ControlOrMeta+Shift+u");
  await expect.poll(effort).toBe("xhigh");
  await send(page, "[hang]");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
  await box(page).press("ControlOrMeta+Shift+o");
  await settled(service, id);
  writeFileSync(file, "[]");
  expect(readFileSync(file, "utf8")).toBe("[]");
});

test("the permissions key opens the menu at Permissions", async ({ page }) => {
  const id = await fresh(page);
  await settled(service, id);
  await box(page).press("ControlOrMeta+Shift+a");
  await expect(page.getByRole("menu", { name: "Composer options" })).toBeVisible();
});

test("the draft offers earlier worktrees, by menu and by key", async ({ page }) => {
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  await service.api("POST", "/api/threads", { project_id: projectId, engine: engines[0]?.id, model: null, title: "Earlier", worktree: "earlier-place", skill_profile: null });
  await page.goto(`${service.page}#/new/${projectId}`);
  await expect(page.locator("li[data-thread-item]").filter({ hasText: "Earlier" })).toBeVisible();
  await box(page).press("ControlOrMeta+Shift+x");
  await page.getByRole("menuitem", { name: "earlier-place" }).click();
  await expect(page.getByRole("button", { name: "This worktree" })).toBeVisible();
  await page.reload();
  await expect(page.locator("li[data-thread-item]").filter({ hasText: "Earlier" })).toBeVisible();
  await box(page).press("ControlOrMeta+Shift+l");
  await expect(page.getByRole("button", { name: "This worktree" })).toBeVisible();
});
