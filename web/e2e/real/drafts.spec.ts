import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Starting threads and the sidebar's way back to them, through the real service. */
const PORT = 5292;

interface Listed {
  id: string;
  title: string;
  model: string | null;
  cwd: string;
  worktree: { path: string; branch: string } | null;
  lifecycle: { settled_at: string | null };
}

let service: Service;
let projectId = "";
let engine = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const row = (page: Page, title: string) => page.locator("li[data-thread-item]").filter({ hasText: title });
const threads = () => service.api<Listed[]>("GET", `/api/threads?project_id=${projectId}`);
const openDraft = async (page: Page) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await expect(box(page)).toBeVisible();
};
const newThread = (title: string, worktree: string | null = null) =>
  service.api<Listed>("POST", "/api/threads", { project_id: projectId, engine, model: null, title, worktree, skill_profile: null });

test.beforeAll(async () => {
  let engines;
  ({ service, projectId, engines } = await startProject(PORT, { scenes: true }));
  engine = engines.find((entry) => /codex/i.test(entry.name))?.id ?? engines[0]?.id ?? "";
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("mod+enter starts in the background, and each send gets its own worktree", async ({ page }) => {
  await openDraft(page);
  await page.getByRole("button", { name: "Current checkout" }).click();
  await page.getByRole("menuitem", { name: "New worktree" }).click();
  await page.getByRole("textbox", { name: "Worktree purpose" }).fill("fix");
  const before = (await threads()).length;
  for (const prompt of ["first background", "second background"]) {
    await box(page).fill(prompt);
    await box(page).press("ControlOrMeta+Enter");
    await expect(box(page)).toHaveValue("");
  }
  await expect(page).toHaveURL(/#\/new\//);
  await expect(page.getByRole("textbox", { name: "Worktree purpose" })).toHaveValue("fix");
  await expect.poll(async () => (await threads()).length).toBe(before + 2);
  const made = (await threads()).filter((thread) => thread.worktree?.path.includes("fix"));
  expect(new Set(made.map((thread) => thread.cwd)).size).toBe(2);
  for (const thread of made) await settled(service, thread.id);
});

test("shift-click adds models, and each one starts a thread and a worktree", async ({ page }) => {
  await openDraft(page);
  const before = (await threads()).length;
  await page.locator("[data-model-trigger]").click();
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await picker.getByRole("button", { name: /Codex/ }).click();
  const options = picker.getByRole("option");
  await expect(options.first()).toBeVisible();
  await options.first().click();
  await page.locator("[data-model-trigger]").click();
  await picker.getByRole("option").nth(1).click({ modifiers: ["Shift"] });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option", { selected: true })).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-model-trigger]")).toContainText("+1");
  await box(page).fill("compare models");
  await box(page).press("Enter");
  await expect(page.getByText("Started 2 threads")).toBeVisible();
  await expect(page).toHaveURL(/#\/new\//);
  const made = (await threads()).slice(0, (await threads()).length - before);
  expect(made).toHaveLength(2);
  expect(new Set(made.map((thread) => thread.cwd)).size).toBe(2);
  expect(new Set(made.map((thread) => thread.model)).size).toBe(2);
  for (const thread of made) await settled(service, thread.id);
});

test("mod+alt+enter sends and leaves a fresh draft", async ({ page }) => {
  await openDraft(page);
  await send(page, "[scene:usage] one");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  await box(page).fill("[scene:usage] two");
  await box(page).press("ControlOrMeta+Alt+Enter");
  await expect(page).toHaveURL(/#\/new\//);
  await expect.poll(async () => JSON.stringify(await service.api("GET", `/api/threads/${id}/messages?limit=10`))).toContain("two");
  await settled(service, id);
});

test("a thread starts in another's worktree", async ({ page }) => {
  const first = await newThread("Worktree owner", "shared-place");
  await openDraft(page);
  await row(page, "Worktree owner").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New thread in this worktree" }).click();
  await expect(page.getByRole("button", { name: "This worktree" })).toBeVisible();
  await send(page, "[scene:usage] same place");
  await expect(page).toHaveURL(/#\/threads\//);
  const second = await service.api<Listed>("GET", `/api/threads/${threadIdOf(page)}`);
  expect(second.cwd).toBe(first.cwd);
  expect(second.worktree?.branch).toBe(first.worktree?.branch);
  await settled(service, second.id);
});

test("a thread's reference is its chip, then its pull request", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const thread = await newThread("Reference me");
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await box(page).click();
  await box(page).press("ControlOrMeta+Shift+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`[Reference me](orbyn://thread/${thread.id})`);
  await row(page, "Reference me").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect(page.getByRole("menuitem", { name: "Thread ID" })).toBeVisible();
});

test("an unsent draft has a row that opens it, and discarding it can be undone", async ({ page }) => {
  const thread = await newThread("Somewhere else");
  await openDraft(page);
  await box(page).fill("half a thought");
  await page.locator(`li[data-thread-item="${thread.id}"] a`).click();
  await expect(page).toHaveURL(/#\/threads\//);
  const draft = page.locator("li.draft-row");
  await expect(draft).toContainText("half a thought");
  await expect(draft).toContainText("Unsent");
  await draft.hover();
  await draft.getByRole("button", { name: "Discard draft" }).click();
  await expect(draft).toBeHidden();
  await page.getByRole("button", { name: /to undo/ }).click();
  await expect(draft).toContainText("half a thought");
  await draft.locator("a").click();
  await expect(box(page)).toHaveValue("half a thought");
  await box(page).fill("");
});

test("files dropped on a row wait in that thread's composer", async ({ page }) => {
  const thread = await newThread("Drop here");
  await openDraft(page);
  const files = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "dropped.txt", { type: "text/plain" }));
    return data;
  });
  await row(page, "Drop here").dispatchEvent("dragover", { dataTransfer: files });
  await row(page, "Drop here").dispatchEvent("drop", { dataTransfer: files });
  await expect(page).toHaveURL(new RegExp(thread.id));
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("dropped.txt");
  await expect(page.getByRole("button", { name: "Remove dropped.txt" })).toBeVisible();
});

test("the open thread stays where it was until you leave it", async ({ page }) => {
  const held = await newThread("Hold me");
  const other = await newThread("Other row");
  await page.goto(`${service.page}#/threads/${held.id}`);
  await expect(row(page, "Hold me")).toHaveAttribute("data-section", "active");
  await service.api("PATCH", `/api/threads/${held.id}`, { settled: true });
  // Long enough for the page's next poll to carry the settle.
  await page.waitForTimeout(5_000);
  await expect(row(page, "Hold me")).toHaveAttribute("data-section", "active");
  await page.locator(`li[data-thread-item="${other.id}"] a`).click();
  await page.getByRole("button", { name: "Settled" }).click();
  await expect(row(page, "Hold me")).toHaveAttribute("data-section", "settled");
});

test("the project folder menu and pen button start a thread", async ({ page }) => {
  await page.goto(service.page);
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("orbyn.prefs.v1") ?? "{}") as Record<string, unknown>;
    localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ ...prefs, projectFolders: true }));
  });
  await page.reload();
  const folder = page.locator(".folder-head").first();
  await folder.locator(".folder-toggle").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Project settings" })).toBeVisible();
  await page.getByRole("menuitem", { name: "New thread" }).click();
  await expect(page).toHaveURL(/#\/new\//);
  await page.goto(`${service.page}#/pulls`);
  await folder.hover();
  await folder.getByRole("link", { name: /^New thread in / }).click();
  await expect(page).toHaveURL(/#\/new\//);
});
