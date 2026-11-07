import { expect, test, type Page } from "@playwright/test";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { settled, startProject, type Service } from "./service";

/** F21: a new thread works in the project's own checkout or in a new sibling worktree. */

interface Listed {
  id: string;
  cwd: string;
  worktree: { path: string; branch: string } | null;
}

let service: Service;
let projectId = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const checkout = (page: Page) => page.locator(".composer-context");
const openDraft = async (page: Page, id = projectId) => {
  await page.goto(`${service.page}#/new/${id}`);
  await expect(box(page)).toBeVisible();
};
const sendAndOpen = async (page: Page, prompt: string) => {
  await box(page).fill(prompt);
  await box(page).press("Enter");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = decodeURIComponent(page.url().split("/threads/")[1] ?? "");
  await settled(service, id);
  return service.api<Listed>("GET", `/api/threads/${id}`);
};
const same = (left: string, right: string) => realpathSync(left) === realpathSync(right);

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("the current checkout is the default and runs in the project folder", async ({ page }) => {
  await openDraft(page);
  await expect(checkout(page).getByRole("button", { name: "Current checkout" })).toBeVisible();
  const thread = await sendAndOpen(page, "local checkout proof");
  expect(thread.worktree).toBeNull();
  expect(same(thread.cwd, service.repo)).toBe(true);
});

test("a new worktree is made beside the primary clone, on its purpose", async ({ page }) => {
  await openDraft(page);
  await checkout(page).getByRole("button", { name: "Current checkout" }).click();
  await page.getByRole("menuitem", { name: "New worktree" }).click();
  await page.getByRole("textbox", { name: "Worktree purpose" }).fill("env-choice");
  const thread = await sendAndOpen(page, "worktree checkout proof");
  expect(thread.worktree).not.toBeNull();
  const path = thread.worktree?.path ?? "";
  expect(basename(path)).toBe("env-choice");
  expect(same(dirname(path), `${service.repo}-wt`)).toBe(true);
  expect(same(thread.cwd, path)).toBe(true);
  expect(thread.worktree?.branch).toMatch(/env-choice$/);
});

test("the device's default checkout mode chooses the draft's starting choice", async ({ page }) => {
  await service.api("PUT", "/api/preferences", { values: { default_thread_env_mode: "worktree" } });
  try {
    await openDraft(page);
    await expect(checkout(page).getByRole("button", { name: "New worktree" })).toBeVisible();
    await checkout(page).getByRole("button", { name: "New worktree" }).click();
    await page.getByRole("menuitem", { name: "Current checkout" }).click();
    await expect(checkout(page).getByRole("button", { name: "Current checkout" })).toBeVisible();
  } finally {
    await service.api("PUT", "/api/preferences", { values: { default_thread_env_mode: null } });
  }
});

test("a folder outside Git offers no worktree choice", async ({ page }) => {
  const folder = await service.api<{ id: string }>("POST", "/api/projects/add", { path: service.folder });
  await service.api("POST", `/api/projects/${folder.id}/trust`);
  await openDraft(page, folder.id);
  await expect(checkout(page).getByText("This folder")).toBeVisible();
  await expect(checkout(page).getByRole("button", { name: /checkout|worktree/i })).toHaveCount(0);
  const thread = await sendAndOpen(page, "plain folder proof");
  expect(thread.worktree).toBeNull();
  expect(same(thread.cwd, service.folder)).toBe(true);
});
