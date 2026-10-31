import { expect, test, type Page } from "@playwright/test";
import { startService, type Service } from "./service";

/** Real runs through the real service, against the protocol double. */
const PORT = 5278;

interface Thread {
  id: string;
  project_id: string;
  active_run: unknown;
}

let service: Service;
let projectId = "";

const send = async (page: Page, text: string) => {
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill(text);
  await box.press("Enter");
};

test.beforeAll(async () => {
  service = await startService(PORT, { fakeEngines: true });
  await service.api("POST", "/api/workspace/setup", {});
  const project = await service.api<{ id: string }>("POST", "/api/projects/add", { path: service.repo });
  projectId = project.id;
  await service.api("POST", `/api/projects/${projectId}/trust`);
});

test.afterAll(() => service.stop());

test("a draft sends, then forks, rewinds and shows the turn's diff", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "hello there");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = decodeURIComponent(page.url().split("/threads/")[1] ?? "");
  await expect(page.locator(".msg-assistant").first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await service.api<Thread>("GET", `/api/threads/${id}`)).active_run, { timeout: 15_000 }).toBeNull();
  await expect(page.getByRole("navigation", { name: "Workspace" }).getByText("A fresh title")).toBeVisible();

  await page.getByRole("button", { name: /^Changes/ }).click();
  const sources = page.getByRole("radiogroup", { name: "Diff source" });
  await expect(sources).toBeVisible();
  for (const name of ["Turn", "Thread", "Branch", "Working tree"]) {
    await sources.getByRole("radio", { name }).click();
    await expect(page.locator(".panel-bar").first()).toBeVisible();
    await expect(page.getByText(/Couldn't/)).toHaveCount(0);
  }

  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find in thread" }).fill("hello");
  await expect(page.locator(".thread-find-count")).toHaveText(/^1\/\d+$/);
  await page.keyboard.press("Escape");

  await page.locator(".msg-assistant").first().hover();
  await page.getByRole("button", { name: "Fork from this response" }).first().click();
  await expect.poll(() => page.url()).not.toContain(id);
  await page.goto(`${service.page}#/threads/${id}`);

  await page.locator(".msg-user").first().hover();
  await page.getByRole("button", { name: "Edit from here" }).first().click();
  await page.getByRole("dialog", { name: "Edit from here?" }).getByRole("button", { name: "Rewind" }).click();
  await expect(page.getByRole("dialog", { name: "Edit from here?" })).toBeHidden();
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);
});

test("the palette finds a message in another thread and opens at it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "remember the zebrafish plan");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = decodeURIComponent(page.url().split("/threads/")[1] ?? "");
  await expect.poll(async () => (await service.api<Thread>("GET", `/api/threads/${id}`)).active_run, { timeout: 15_000 }).toBeNull();
  await page.goto(`${service.page}#/new/${projectId}`);

  await expect(page.locator(".hero-project")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search" }).fill("zebrafish");
  await expect(palette.getByText("Messages")).toBeVisible();
  await palette.getByRole("button", { name: /zebrafish/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/threads/${id}`));
  await expect(page.locator("[data-revealed]")).toContainText("zebrafish");
});

test("a question and an approval are answered from the composer", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[question] which one");
  const panel = page.getByRole("region", { name: "Question from the agent" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button").first().click();
  const typed = panel.getByRole("textbox").first();
  if (await typed.isVisible()) await typed.fill("Either");
  await panel.getByRole("button", { name: "Submit answers" }).click();
  await expect(panel).toBeHidden({ timeout: 15_000 });

  const id = decodeURIComponent(page.url().split("/threads/")[1] ?? "");
  await expect.poll(async () => (await service.api<Thread>("GET", `/api/threads/${id}`)).active_run, { timeout: 15_000 }).toBeNull();
  await send(page, "[approve] change a file");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect.poll(async () => (await service.api<Thread>("GET", `/api/threads/${id}`)).active_run, { timeout: 15_000 }).toBeNull();
});

test("a thread archives, comes back from Archive, and deletes", async ({ page }) => {
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const made = await service.api<Thread>("POST", "/api/threads", {
    project_id: projectId,
    engine: engines[0]?.id,
    model: null,
    title: "Throwaway",
    worktree: null,
    skill_profile: null,
  });
  await page.goto(service.page);
  const row = page.locator("li[data-thread-item]").filter({ hasText: "Throwaway" });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive thread" }).click();
  await expect(row).toHaveCount(0);
  await page.goto(`${service.page}#/settings/archive`);
  await page.getByRole("button", { name: "Unarchive" }).first().click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(row).toHaveCount(1);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete thread?" }).getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  await expect(service.api("GET", `/api/threads/${made.id}`)).rejects.toThrow("404");
});
