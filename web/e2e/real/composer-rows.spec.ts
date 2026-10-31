import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Composer rows that reach the engine, through the real service. */

let service: Service;
let projectId = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const fresh = async (page: Page, prompt: string) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  return threadIdOf(page);
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("Restart agent session leaves a row and a handoff", async ({ page }) => {
  const id = await fresh(page, "hello");
  await settled(service, id);
  await box(page).press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).locator("input").fill("restart");
  await page.getByRole("dialog", { name: "Command palette" }).getByText("Restart agent session").click();
  await expect(page.getByText("Agent session restarted.")).toBeVisible();
});

test("a goal shows at the end of the thread and can be cleared", async ({ page }) => {
  const id = await fresh(page, "/goal ship the thing");
  await settled(service, id);
  await expect(page.getByText("Goal: ship the thing")).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("Goal: ship the thing")).toBeHidden({ timeout: 10_000 });
});

test("a narrow composer folds its controls into one menu", async ({ page }) => {
  const id = await fresh(page, "hello");
  await settled(service, id);
  await page.setViewportSize({ width: 420, height: 800 });
  await page.getByRole("button", { name: "Composer controls" }).click();
  await expect(page.getByRole("menuitem", { name: "Effort" })).toBeVisible();
  await page.getByRole("menuitem", { name: /^Permissions/ }).click();
  await expect(page.getByRole("menu", { name: "Composer options" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Composer controls" }).click();
  await page.getByRole("menuitem", { name: "Plan" }).click();
  await expect.poll(async () => (await service.api<{ lifecycle: { plan_mode: boolean } }>("GET", `/api/threads/${id}`)).lifecycle.plan_mode).toBe(true);
  await service.api("PATCH", `/api/threads/${id}`, { plan_mode: false });
});

test("a thread dragged onto the composer becomes a link", async ({ page }) => {
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const other = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: engines[0]?.id, model: null, title: "Drag me", worktree: null, skill_profile: null });
  const id = await fresh(page, "hello");
  await settled(service, id);
  const row = page.locator(`li[data-thread-item="${other.id}"]`);
  const from = await row.boundingBox();
  const to = await box(page).boundingBox();
  if (!from || !to) throw new Error("no boxes");
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(to.x + 40, to.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect(box(page)).toHaveValue(new RegExp(`\\[Drag me\\]\\(orbyn://thread/${other.id}\\)`));
  await box(page).fill("");
});

test("with streaming set to whole turns, a reply still arrives whole", async ({ page }) => {
  await service.api("PUT", "/api/preferences", { values: { response_streaming_mode: "turn" } });
  const id = await fresh(page, "hello");
  await settled(service, id);
  await expect(page.getByText("hello from", { exact: false }).first()).toBeVisible();
  await service.api("PUT", "/api/preferences", { values: { response_streaming_mode: "paragraph" } });
});
