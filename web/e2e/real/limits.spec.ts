import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** A provider's limit stop through the real service, from the row to the continuation. */

interface Listed {
  id: string;
  lifecycle: {
    snoozed_until: string | null;
    woke_at?: string;
    limit?: { message: string; resets_at: string | null; resume_at: string | null };
  };
}

let service: Service;
let projectId = "";

const thread = (id: string) => service.api<Listed>("GET", `/api/threads/${id}`);
const row = (page: Page, id: string) => page.locator(`li[data-thread-item="${id}"]`);
const banner = (page: Page) => page.getByRole("status", { name: "Limited" });
const started = async (page: Page, prompt: string) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  return id;
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("a limit stop shows Limited, and Resume at reset can be cancelled", async ({ page }) => {
  const id = await started(page, "[scene:limit] work");
  await expect(row(page, id).getByText("Limited")).toBeVisible();
  await expect(banner(page)).toContainText("You've hit your usage limit.");
  await expect(banner(page)).toContainText("Resets");
  await banner(page).getByRole("button", { name: "Resume at reset" }).click();
  await expect.poll(async () => (await thread(id)).lifecycle.limit?.resume_at).toBe("2100-01-01T00:00:00Z");
  await banner(page).getByRole("button", { name: "Cancel resume" }).click();
  await expect.poll(async () => (await thread(id)).lifecycle.limit?.resume_at).toBeNull();
});

test("Snooze until reset hides the thread until the allowance returns", async ({ page }) => {
  const id = await started(page, "[scene:limit] more");
  await banner(page).getByRole("button", { name: "Snooze until reset" }).click();
  await expect.poll(async () => (await thread(id)).lifecycle.snoozed_until).toBe("2100-01-01T00:00:00Z");
  await expect(row(page, id)).toHaveAttribute("data-section", "snoozed");
});

test("Resume continues the thread and clears the limit", async ({ page }) => {
  const id = await started(page, "[scene:limit-open] work");
  await expect(banner(page).getByRole("button", { name: "Resume at reset" })).toBeHidden();
  await banner(page).getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("Continue where you left off.")).toBeVisible();
  await expect.poll(async () => (await thread(id)).lifecycle.limit).toBeUndefined();
  await settled(service, id);
  await expect(banner(page)).toBeHidden();
});

test("a thread woken early says so until dismissed", async ({ page }) => {
  const id = await started(page, "[scene:limit-open] wake");
  const target = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: (await service.api<{ engine: string }>("GET", `/api/threads/${id}`)).engine, model: null, title: "Woken", worktree: null, skill_profile: null });
  await service.api("POST", `/api/threads/${target.id}/runs`, { prompt: "[hang]" });
  await expect.poll(async () => (await service.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${target.id}`)).active_run?.state).toBe("running");
  await service.api("PATCH", `/api/threads/${target.id}`, { snoozed_until: "2099-01-01T00:00:00Z" });
  const run = await service.api<{ active_run: { id: string } }>("GET", `/api/threads/${target.id}`);
  await service.api("POST", `/api/threads/${target.id}/force-stop`, {});
  await settled(service, target.id);
  expect(run.active_run.id).toBeTruthy();
  await expect.poll(async () => (await thread(target.id)).lifecycle.woke_at).toBeTruthy();
  await page.reload();
  await row(page, target.id).getByRole("button", { name: "Dismiss Woke" }).click();
  await expect(row(page, target.id).getByRole("button", { name: "Dismiss Woke" })).toBeHidden();
  await expect.poll(async () => (await thread(target.id)).lifecycle.woke_at).toBeUndefined();
});

test("with the setting on, a stop resumes itself at the reset", async ({ page }) => {
  test.setTimeout(100_000);
  await service.api("PUT", "/api/preferences", { values: { auto_resume_limited_threads: true } });
  const id = await started(page, "[scene:limit-soon] work");
  await expect.poll(async () => JSON.stringify(await service.api("GET", `/api/threads/${id}/messages?limit=20`)), { timeout: 80_000 }).toContain("Continue where you left off.");
  await service.api("PUT", "/api/preferences", { values: { auto_resume_limited_threads: false } });
});
