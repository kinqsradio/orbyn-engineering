import { expect, test, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { openDetails, startProject, type Service } from "./service";

/** Webhook tasks and the after-thread trigger, set up in Settings and fired for real. */

let service: Service;
let projectId = "";

const tasksPage = async (page: Page) => {
  await page.goto(`${service.page}#/settings/tasks`);
  await expect(newTask(page)).toBeVisible();
};
// The page bar and the empty list each offer one; the bar's comes first.
const newTask = (page: Page) => page.getByRole("button", { name: "New task" }).first();

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("a webhook task filters, verifies, drops repeats and logs each delivery", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await tasksPage(page);
  await newTask(page).click();
  const dialog = page.getByRole("dialog", { name: "New scheduled task" });
  await dialog.getByLabel("Name").fill("On pushes");
  await dialog.getByLabel("What should the agent do?").fill("Look at {{body.action}}");
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

  await page.getByRole("button", { name: "Open On pushes" }).click();
  await page.getByRole("button", { name: "Create address" }).click();
  const url = new URL((await page.locator("main code").first().innerText()).trim());

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

  // The deliveries load when the task opens, so open it again after the calls arrived.
  await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
  await page.getByRole("button", { name: "Open On pushes" }).click();
  await page.getByRole("tab", { name: "Webhook deliveries" }).click();
  const rows = page.getByRole("table", { name: "Deliveries" }).getByRole("row");
  // The header row and the four calls.
  await expect(rows).toHaveCount(5);
  for (const state of ["202 Accepted", "200 Filtered out", "200 Duplicate", "200 Bad signature"]) {
    await expect(page.getByRole("table", { name: "Deliveries" }).getByText(state, { exact: true })).toBeVisible();
  }
  // The accepted call started a thread whose prompt carries the body as marked data.
  await page.getByRole("button", { name: "Open thread" }).click();
  await expect(page.getByText(/Look at <webhook-data-[0-9a-f]+>opened/)).toBeVisible();

  await page.goto(`${service.page}#/settings/tasks`);
  await page.getByRole("button", { name: "Edit On pushes" }).click();
  const edit = page.getByRole("dialog", { name: "Edit scheduled task" });
  await expect(edit.getByText("Saved. Leave empty to keep it.")).toBeVisible();
  await expect(edit.getByLabel("Filter 1 value")).toHaveValue("opened");
  await edit.getByRole("button", { name: "Save changes" }).click();
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
  await newTask(page).click();
  const dialog = page.getByRole("dialog", { name: "New scheduled task" });
  await dialog.getByLabel("Name").fill("Review after");
  await dialog.getByLabel("What should the agent do?").fill("Review it");
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
  await newTask(page).click();
  const dialog = page.getByRole("dialog", { name: "New scheduled task" });
  await dialog.getByLabel("Name").fill("Hourly");
  await dialog.getByLabel("What should the agent do?").fill("[scene:usage] check");
  await dialog.getByRole("button", { name: "Save task" }).click();
  await expect(dialog).toBeHidden();
  const task = async () => (await service.api<{ name: string; enabled: boolean; last_status: string }[]>("GET", "/api/tasks")).find((entry) => entry.name.startsWith("Hourly"));
  await page.getByRole("switch", { name: "Enable Hourly" }).click();
  await expect.poll(async () => (await task())?.enabled).toBe(false);
  await page.getByRole("switch", { name: "Enable Hourly" }).click();
  await expect.poll(async () => (await task())?.enabled).toBe(true);
  await page.getByRole("button", { name: "Open Hourly" }).click();
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  await expect.poll(async () => (await task())?.last_status).not.toBe("never");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit scheduled task" });
  await edit.getByLabel("Name").fill("Hourly check");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
  await page.getByRole("button", { name: "Edit Hourly check" }).click();
  await edit.getByRole("button", { name: "Delete task…" }).click();
  await page.getByRole("dialog", { name: "Delete Hourly check?" }).getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Hourly check" })).toBeHidden();
});

test("a task bound to a thread pauses, runs and edits from the details card", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: engines.find((engine) => engine.id === "codex")?.id,
    title: "Nightly review",
    model: null,
    worktree: null,
    skill_profile: null,
  });
  const task = await service.api<{ id: string }>("POST", "/api/tasks", {
    project_id: projectId,
    thread_id: thread.id,
    name: "Nightly review",
    prompt: "[scene:usage] check",
    engine: "codex",
    schedule: { kind: "interval", every_minutes: 60, time: null, weekdays: [], utc_offset_minutes: 0, only_on_success: false },
  });
  const stored = async () =>
    (await service.api<{ id: string; name: string; enabled: boolean; last_status: string }[]>("GET", "/api/tasks")).find(
      (entry) => entry.id === task.id,
    );

  await page.goto(`${service.page}#/threads/${thread.id}`);
  let details = await openDetails(page);
  const automations = () => details.getByRole("list", { name: "Automations" });
  await expect(automations()).toContainText("Nightly review");
  await expect(automations().getByRole("listitem")).toHaveCount(1);
  await expect(automations()).not.toContainText("On pushes");

  // The mutation reaches the real service; only the browser's subsequent read
  // fails. The switch and schedule must keep the confirmed saved pause state.
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "Refresh unavailable." }) })
      : route.continue(),
  );
  await details.getByRole("switch", { name: "Enable Nightly review" }).click();
  await expect.poll(async () => (await stored())?.enabled).toBe(false);
  await expect(details.getByRole("alert")).toContainText(/Paused Nightly review.*refresh/);
  await expect(details.getByRole("switch", { name: "Enable Nightly review" })).toBeEnabled();
  await expect(details.getByRole("switch", { name: "Enable Nightly review" })).not.toBeChecked();
  await expect(automations()).toContainText("paused");
  await page.unroute("**/api/tasks");
  await details.getByRole("switch", { name: "Enable Nightly review" }).click();
  await expect.poll(async () => (await stored())?.enabled).toBe(true);
  await expect(details.getByRole("switch", { name: "Enable Nightly review" })).toBeChecked();
  await expect(details.getByRole("alert")).toHaveCount(0);

  await details.getByRole("button", { name: "Run Nightly review now" }).click();
  await expect.poll(async () => (await stored())?.last_status).toBe("started");

  await details.getByRole("button", { name: "Edit Nightly review" }).click();
  await expect(page).toHaveURL((url) => url.hash === `#/settings/tasks?task=${task.id}&edit=1`);
  const edit = page.getByRole("dialog", { name: "Edit scheduled task" });
  await expect(edit.getByLabel("Name")).toHaveValue("Nightly review");
  await edit.getByLabel("Name").fill("Nightly check");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await expect(page).toHaveURL((url) => url.hash === "#/settings/tasks");

  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page).toHaveURL((url) => url.hash === `#/threads/${thread.id}`);
  details = await openDetails(page);
  await expect(automations()).toContainText("Nightly check");
  await details.getByRole("button", { name: "Manage scheduled tasks" }).click();
  await expect(page).toHaveURL((url) => url.hash === "#/settings/tasks");
  // The thread details behind Settings has an Edit button with the same name.
  await expect(
    page.getByRole("region", { name: "Settings" }).getByRole("button", { name: "Edit Nightly check" }),
  ).toBeVisible();
});
