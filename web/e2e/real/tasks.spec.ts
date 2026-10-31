import { expect, test, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { startProject, type Service } from "./service";

/** Webhook tasks and the after-thread trigger, set up in Settings and fired for real. */
const PORT = 5286;

let service: Service;
let projectId = "";

const tasksPage = async (page: Page) => {
  await page.goto(`${service.page}#/settings/tasks`);
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject(PORT, { scenes: true }));
});
test.afterAll(() => service.stop());

test("a webhook task filters, verifies, drops repeats and logs each delivery", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await tasksPage(page);
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New scheduled task" });
  await dialog.getByLabel("Name").fill("On pushes");
  await dialog.getByLabel("Prompt").fill("Look at {{body.action}}");
  await dialog.getByLabel("Schedule").selectOption("webhook");
  await dialog.getByLabel("Header").fill("X-Sig");
  await dialog.getByLabel("Prefix").fill("sha256=");
  await dialog.getByLabel("Secret").fill("not-a-real-secret");
  await dialog.getByRole("button", { name: "Add filter" }).click();
  await dialog.getByLabel("Filter 1 path").fill("action");
  await dialog.getByLabel("Filter 1 value").fill("opened");
  await dialog.getByLabel("Skip repeats of this field").fill("delivery");
  await dialog.getByRole("button", { name: "Save task" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Webhook address for On pushes" }).click();
  const address = page.getByRole("dialog", { name: "Webhook address" });
  await address.getByRole("button", { name: "Issue address" }).click();
  const url = new URL((await address.locator(".command code").innerText()).trim());
  await address.getByRole("button", { name: "Close", exact: true }).first().click();

  const post = (body: string, signed = true) =>
    fetch(`${service.url}${url.pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sig": signed ? `sha256=${createHmac("sha256", "not-a-real-secret").update(body).digest("hex")}` : "sha256=0",
      },
      body,
    });
  await post(JSON.stringify({ action: "opened", delivery: "one" }));
  await post(JSON.stringify({ action: "closed", delivery: "two" }));
  await post(JSON.stringify({ action: "opened", delivery: "one" }));
  await post(JSON.stringify({ action: "opened", delivery: "three" }), false);

  await page.getByRole("button", { name: "Deliveries for On pushes" }).click();
  const log = page.getByRole("dialog", { name: "Deliveries for On pushes" });
  const rows = log.getByRole("list", { name: "Deliveries" }).getByRole("listitem");
  await expect(rows).toHaveCount(4);
  for (const state of ["Accepted", "Filtered out", "Duplicate", "Bad signature"]) {
    await expect(log.getByText(state, { exact: true })).toBeVisible();
  }
  await log.getByText("Accepted", { exact: true }).click();
  await expect(log.getByText(/Look at <webhook-data-[0-9a-f]+>opened/)).toBeVisible();
  await log.getByRole("button", { name: "Close", exact: true }).first().click();

  await page.getByRole("button", { name: "Edit On pushes" }).click();
  const edit = page.getByRole("dialog", { name: "Edit scheduled task" });
  await expect(edit.getByText("Saved. Leave empty to keep it.")).toBeVisible();
  await expect(edit.getByLabel("Filter 1 value")).toHaveValue("opened");
  await edit.getByRole("button", { name: "Save task" }).click();
  await expect(edit).toBeHidden();
  const saved = await service.api<{ id: string; has_secret: boolean; filters: unknown[] }[]>("GET", "/api/tasks");
  expect(saved[0]).toMatchObject({ has_secret: true, filters: [{ path: "action", op: "equals", value: "opened" }] });
});

test("an after-thread task names the thread it follows", async ({ page }) => {
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: engines.find((engine) => engine.id === "codex")?.id,
    title: "Build it",
    model: null,
    worktree: null,
    skill_profile: null,
  });
  await tasksPage(page);
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New scheduled task" });
  await dialog.getByLabel("Name").fill("Review after");
  await dialog.getByLabel("Prompt").fill("Review it");
  await dialog.getByLabel("Schedule").selectOption("after_thread");
  await expect(dialog.getByRole("button", { name: "Save task" })).toBeDisabled();
  await dialog.getByLabel("Thread").selectOption(thread.id);
  await dialog.getByLabel("Only when it succeeds").check();
  await dialog.getByRole("button", { name: "Save task" }).click();
  await expect(dialog).toBeHidden();
  const tasks = await service.api<{ name: string; schedule: { after_thread: string; only_on_success: boolean } }[]>("GET", "/api/tasks");
  expect(tasks.find((task) => task.name === "Review after")?.schedule).toMatchObject({ after_thread: thread.id, only_on_success: true });
});

test("a task pauses, runs now, edits and goes", async ({ page }) => {
  await tasksPage(page);
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New scheduled task" });
  await dialog.getByLabel("Name").fill("Hourly");
  await dialog.getByLabel("Prompt").fill("[scene:usage] check");
  await dialog.getByRole("button", { name: "Save task" }).click();
  await expect(dialog).toBeHidden();
  const task = async () => (await service.api<{ name: string; enabled: boolean; last_status: string }[]>("GET", "/api/tasks")).find((entry) => entry.name.startsWith("Hourly"));
  await page.getByRole("switch", { name: "Enable Hourly" }).click();
  await expect.poll(async () => (await task())?.enabled).toBe(false);
  await page.getByRole("switch", { name: "Enable Hourly" }).click();
  await expect.poll(async () => (await task())?.enabled).toBe(true);
  await page.getByRole("button", { name: "Run Hourly" }).click();
  await expect.poll(async () => (await task())?.last_status).not.toBe("never");
  await page.getByRole("button", { name: "Edit Hourly" }).click();
  const edit = page.getByRole("dialog", { name: "Edit scheduled task" });
  await edit.getByLabel("Name").fill("Hourly check");
  await edit.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("button", { name: "Edit Hourly check" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Hourly check" }).click();
  await expect(page.getByRole("button", { name: "Edit Hourly check" })).toBeHidden();
});
