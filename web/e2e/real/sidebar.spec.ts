import { expect, test, type Locator, type Page } from "@playwright/test";
import { startService, type Service } from "./service";

const PORT = 5277;

interface Thread {
  id: string;
  title: string;
  lifecycle: { pinned_at: string | null; settled_at: string | null; snoozed_until: string | null; position: number };
}

let service: Service;
let projectId = "";
const ids: Record<string, string> = {};

const thread = (id: string) => service.api<Thread>("GET", `/api/threads/${id}`);
const row = (page: Page, title: string) => page.locator("li[data-thread-item]").filter({ hasText: title });
const section = (locator: Locator) => locator.getAttribute("data-section");

async function dragTo(page: Page, from: Locator, y: number) {
  const box = await from.boundingBox();
  if (!box) throw new Error("no row");
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2 + 10, { steps: 3 });
  await page.mouse.move(box.x + 60, y, { steps: 12 });
}

test.beforeAll(async () => {
  service = await startService(PORT);
  await service.api("POST", "/api/workspace/setup", {});
  const projects = await service.api<{ id: string }[]>("GET", "/api/projects");
  projectId = projects[0]?.id ?? "";
  await service.api("POST", `/api/projects/${projectId}/trust`);
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  for (const title of ["Alpha", "Bravo", "Charlie", "Delta"]) {
    const created = await service.api<Thread>("POST", "/api/threads", {
      project_id: projectId,
      engine: engines[0]?.id,
      title,
    });
    ids[title] = created.id;
  }
});

test.afterAll(() => service.stop());

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(service.page);
  await expect(row(page, "Alpha")).toBeVisible();
});

test("settle moves to the shelf and undo restores it", async ({ page }) => {
  await row(page, "Alpha").hover();
  await row(page, "Alpha").getByRole("button", { name: "Settle thread" }).click();
  await expect(page.getByRole("button", { name: "Settled" })).toBeVisible();
  await expect.poll(async () => (await thread(ids.Alpha ?? "")).lifecycle.settled_at).not.toBeNull();
  await page.getByRole("button", { name: /to undo/ }).click();
  await expect.poll(async () => (await thread(ids.Alpha ?? "")).lifecycle.settled_at).toBeNull();
  await expect(row(page, "Alpha")).toBeVisible();
});

test("the menu pins, snoozes through Custom and wakes", async ({ page }) => {
  await row(page, "Bravo").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin thread" }).click();
  await expect.poll(async () => (await thread(ids.Bravo ?? "")).lifecycle.pinned_at).not.toBeNull();
  await row(page, "Bravo").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin thread" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unpinned" })).toBeVisible();

  await row(page, "Bravo").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "Custom…" }).click();
  await page.getByRole("dialog", { name: "Custom snooze" }).getByRole("button", { name: "Snooze" }).click();
  await expect.poll(async () => (await thread(ids.Bravo ?? "")).lifecycle.snoozed_until).not.toBeNull();
  await expect(page.getByRole("button", { name: /^Snoozed/ })).toBeVisible();
  await row(page, "Bravo").hover();
  await row(page, "Bravo").getByRole("button", { name: "Wake thread now" }).click();
  await expect.poll(async () => (await thread(ids.Bravo ?? "")).lifecycle.snoozed_until).toBeNull();
});

test("dragging reorders, pins and settles with an action badge", async ({ page }) => {
  const list = page.locator("li[data-section=active]");
  await expect(list).toHaveCount(4);
  const titles = await list.locator(".thread-row-title").allInnerTexts();
  const moved = titles.at(-1) ?? "";
  const pinned = titles[0] ?? "";
  const top = (await list.first().boundingBox())?.y ?? 0;
  const boundary = 20;

  await dragTo(page, row(page, moved), top + boundary * 2 + 8);
  await page.mouse.up();
  await expect(list.first()).toContainText(moved);
  await expect
    .poll(async () => (await service.api<Thread[]>("GET", `/api/threads?project_id=${projectId}`))[0]?.title)
    .toBe(moved);
  await page.reload();
  await expect(page.locator("li[data-section=active]").first()).toContainText(moved);

  const id = ids[pinned] ?? "";
  await dragTo(page, row(page, pinned), top + 8);
  await expect(row(page, pinned).getByRole("status")).toHaveText("Pin");
  await page.mouse.up();
  await expect.poll(async () => (await thread(id)).lifecycle.pinned_at).not.toBeNull();
  await expect(row(page, pinned)).toHaveAttribute("data-section", "pinned");

  await dragTo(page, row(page, pinned), top + 200);
  const shelf = await page.locator(".group[data-drop-section=settled]").boundingBox();
  await page.mouse.move(100, (shelf?.y ?? 0) + 10, { steps: 4 });
  await expect(row(page, pinned).getByRole("status")).toHaveText("Settle");
  await page.mouse.up();
  await expect.poll(async () => (await thread(id)).lifecycle.settled_at).not.toBeNull();
  await expect.poll(async () => (await thread(id)).lifecycle.pinned_at).toBeNull();
  await page.getByRole("button", { name: /to undo/ }).click();
  await expect.poll(async () => (await thread(id)).lifecycle.pinned_at).not.toBeNull();
  await service.api("PATCH", `/api/threads/${id}`, { pinned: false });
});

test("multi-select settles in bulk, and press-drag settles a range", async ({ page }) => {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await row(page, "Alpha").click({ modifiers: [mod] });
  await row(page, "Bravo").click({ modifiers: [mod] });
  await row(page, "Alpha").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle (2)" }).click();
  await expect.poll(async () => (await thread(ids.Alpha ?? "")).lifecycle.settled_at).not.toBeNull();
  await expect.poll(async () => (await thread(ids.Bravo ?? "")).lifecycle.settled_at).not.toBeNull();
  await expect(page.getByRole("status").filter({ hasText: "Settled 2" })).toBeVisible();
  await page.getByRole("button", { name: /to undo/ }).click();
  await expect.poll(async () => (await thread(ids.Bravo ?? "")).lifecycle.settled_at).toBeNull();

  await expect(page.locator("li[data-section=active]")).toHaveCount(4);
  const rows = page.locator("li[data-section=active]");
  const first = rows.first();
  await first.hover();
  const settle = await first.getByRole("button", { name: "Settle thread" }).boundingBox();
  const end = await rows.nth(1).boundingBox();
  if (!settle || !end) throw new Error("no rows");
  await page.mouse.move(settle.x + 8, settle.y + 8);
  await page.mouse.down();
  await page.mouse.move(settle.x + 8, settle.y + 20, { steps: 3 });
  await page.mouse.move(settle.x + 8, end.y + end.height / 2, { steps: 6 });
  await expect(page.locator("li[data-section=active] .row-drop-badge")).toHaveCount(2);
  await page.mouse.up();
  await expect(page.locator("li[data-section=active]")).toHaveCount(2);
  await page.getByRole("button", { name: /to undo/ }).click();
  await expect(page.locator("li[data-section=active]")).toHaveCount(4);
  expect(await section(rows.first())).toBe("active");
});

test("usage reads the real report and limits", async ({ page }) => {
  await page.getByRole("link", { name: "Usage" }).click();
  const usage = page.getByRole("dialog", { name: "Usage" });
  await expect(usage.getByRole("radio", { name: "30 days" })).toBeChecked();
  await usage.getByRole("radio", { name: "7 days" }).click();
  await usage.getByRole("button", { name: "Refresh usage" }).click();
  await usage.getByRole("radio", { name: "Limits" }).click();
  await expect(usage.getByText(/reports limits|left|:/).first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(usage).toBeHidden();
});
