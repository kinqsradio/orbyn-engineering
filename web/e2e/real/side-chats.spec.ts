import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Side chats through the real service: asked beside a thread, then brought back. */
const PORT = 5294;

interface Listed {
  id: string;
  title: string;
  active_run: unknown;
  lifecycle: { relation: string | null; parent_thread_id: string | null };
}

let service: Service;
let projectId = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ }).first();
const pane = (page: Page) => page.locator("[data-side-chat]");
const sideOf = async (id: string) =>
  (await service.api<Listed[]>("GET", `/api/threads?project_id=${projectId}`)).filter((thread) => thread.lifecycle.parent_thread_id === id && thread.lifecycle.relation === "side");

const started = async (page: Page, prompt: string) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  return threadIdOf(page);
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject(PORT, { scenes: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1500, height: 900 }));

test("/side asks in a tab while the row list stays as it was, and it can be found again", async ({ page }) => {
  const id = await started(page, "[scene:usage] main");
  await settled(service, id);
  await box(page).fill("/side what did it find?");
  await box(page).press("Enter");
  await expect(page.getByRole("tab", { name: "Side chat" })).toBeVisible();
  await expect(pane(page).getByText("what did it find?")).toBeVisible();
  const [side] = await sideOf(id);
  expect(side).toBeTruthy();
  await settled(service, side?.id ?? "");
  await expect(page.locator(`li[data-thread-item="${side?.id}"]`)).toHaveCount(0);
  await page.reload();
  await expect(pane(page)).toBeVisible();
  await page.getByRole("button", { name: "Close Side chat" }).click();
  await expect(page.getByRole("tab", { name: "Side chat" })).toBeHidden();
  await expect((await sideOf(id)).length).toBe(1);
  await page.getByRole("button", { name: "Close surfaces" }).click();
  await page.getByRole("complementary", { name: "Thread details" }).getByRole("button", { name: /Side chat/ }).click();
  await expect(pane(page).getByText("what did it find?")).toBeVisible();
  await pane(page).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await sideOf(id)).length).toBe(0);
});

test("a side chat opens from the launcher while the thread works, and an unused one goes with its tab", async ({ page }) => {
  const id = await started(page, "[hang]");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Surfaces" }).click().catch(() => undefined);
  await page.getByRole("button", { name: "New surface" }).click();
  await page.locator(".launcher").getByRole("button", { name: /Side chat/ }).click();
  await expect(pane(page)).toBeVisible();
  await expect.poll(async () => (await sideOf(id)).length).toBe(1);
  await expect(pane(page).getByRole("button", { name: "Bring back" })).toBeDisabled();
  await page.getByRole("button", { name: "Close Side chat" }).click();
  await expect.poll(async () => (await sideOf(id)).length).toBe(0);
  await page.getByRole("button", { name: "Stop" }).click();
  await settled(service, id);
});

test("Bring back waits for an idle thread and reports what it did", async ({ page }) => {
  const id = await started(page, "[scene:usage] base");
  await settled(service, id);
  await box(page).fill("/btw a note");
  await box(page).press("Enter");
  const button = pane(page).getByRole("button", { name: "Bring back" });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
  await expect(page.getByText("The thread gets this with your next message")).toBeVisible();
});
