import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { libraryReady, startService, type Service } from "./service";

/** A fresh install against the real service, which the mock can't reach. */
const PORT = 5276;
/** The desktop window less its native title bar. */
const WINDOW = { width: 1280, height: 792 };

let service: Service;

test.beforeAll(async () => {
  service = await startService(PORT);
});

test.afterAll(() => service.stop());

test("a fresh install opens on the draft flow with no setup step", async ({ page }) => {
  await page.setViewportSize(WINDOW);
  await page.goto(service.page);
  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
  await expect(page.locator(".no-projects").getByRole("button", { name: "Add project" })).toBeVisible();
  await expect(page.locator(".no-projects").getByRole("button", { name: "Start without a project" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await expect(page.getByText(/set up/i)).toHaveCount(0);
  await expect(page.getByText("Skills library")).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a folder is added where it is, and a thread can start without a project", async ({ page }) => {
  await libraryReady(service);
  await page.setViewportSize(WINDOW);
  await page.goto(service.page);
  await page.getByRole("button", { name: "Start without a project" }).click();
  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "No project" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this draft");

  await page.getByRole("button", { name: "No project" }).click();
  await page.getByRole("option", { name: "Add project" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("button", { name: /Local folder/ }).click();
  await palette.getByLabel("Folder path").fill(service.folder);
  await palette.getByLabel("Folder path").press("Enter");
  await page.getByRole("button", { name: "Trust folder" }).click();
  await expect(page.locator(".hero-project")).toHaveText("my-folder");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this draft");
  expect(existsSync(join(service.folder, ".git"))).toBe(false);

  await page.getByRole("button", { name: "or start without a project" }).click();
  await expect(page.getByRole("button", { name: "No project" })).toBeVisible();
  const thread = await service.api<{ id: string; scratch: boolean }>("POST", "/api/threads", {
    engine: (await service.api<{ id: string }[]>("GET", "/api/engines"))[0]?.id,
    title: "Scratch work",
    model: null,
    worktree: null,
    skill_profile: null,
  });
  expect(thread.scratch).toBe(true);
  await page.reload();
  const row = page.locator("li[data-thread-item]").filter({ hasText: "Scratch work" });
  await expect(row).toContainText("No project");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Turn into project" }).click();
  await expect
    .poll(async () => (await service.api<{ scratch: boolean }>("GET", `/api/threads/${thread.id}`)).scratch)
    .toBe(false);
});

test("the pull requests page reads the real list", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  await expect(page.getByRole("heading", { name: "Pull requests", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No pull requests" })).toBeVisible({ timeout: 15_000 });
});
