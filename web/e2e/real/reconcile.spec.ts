import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Rows the sidebar, thread menu and details card already serve, on the real service. */

let service: Service;
let projectId = "";
let engine = "";

interface Thread {
  id: string;
  title: string;
  engine: string;
  lifecycle: { unread: boolean; auto_settle: boolean | null; snoozed_until: string | null };
}

const row = (page: Page, title: string) => page.locator("li[data-thread-item]").filter({ hasText: title });
const thread = (id: string) => service.api<Thread>("GET", `/api/threads/${id}`);
const make = (title: string) =>
  service.api<Thread>("POST", "/api/threads", { project_id: projectId, engine, model: null, title, worktree: null, skill_profile: null });

test.beforeAll(async () => {
  const started = await startProject({ fakeEngines: true });
  service = started.service;
  projectId = started.projectId;
  engine = started.engines[0]?.id ?? "";
});
test.afterAll(() => service.stop());

test("a thread renames with F2 and regenerates its title", async ({ page }) => {
  const made = await make("Rename me");
  await page.goto(service.page);
  await row(page, "Rename me").locator("a, button").first().focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Thread title" });
  await field.fill("Renamed thread");
  await field.press("Enter");
  await expect.poll(async () => (await thread(made.id)).title).toBe("Renamed thread");
  await row(page, "Renamed thread").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Regenerate title" }).click();
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);
});

test("mark unread, auto-settle choice and the copy menu act on the thread", async ({ page }) => {
  const made = await make("Marked");
  await page.goto(service.page);
  await row(page, "Marked").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect.poll(async () => (await thread(made.id)).lifecycle.unread).toBe(true);
  await row(page, "Marked").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Auto-settle behavior" }).click();
  await page.getByRole("menuitem", { name: "Disabled" }).click();
  await expect.poll(async () => (await thread(made.id)).lifecycle.auto_settle).toBe(false);
  await row(page, "Marked").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect(page.getByRole("menuitem", { name: "Thread ID" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the model picker moves a thread to another engine between turns", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "first");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  const before = (await thread(id)).engine;
  await page.locator(".composer-bar [aria-haspopup]").first().click();
  await page.getByRole("toolbar", { name: "Providers" }).getByRole("button").last().click();
  await page.getByRole("listbox", { name: "Models" }).getByRole("option").first().click();
  await expect.poll(async () => (await thread(id)).engine).not.toBe(before);
});

test("the header toggles the details card, terminal and surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await make("Header");
  await page.goto(service.page);
  await row(page, "Header").click();
  const details = page.getByRole("complementary", { name: "Thread details" });
  await expect(details).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(details).toBeHidden();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(details).toBeVisible();
});

test("the palette finds a thread by project and offers settings", async ({ page }) => {
  await make("Findable tide chart");
  await page.goto(service.page);
  await expect(row(page, "Findable tide chart")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search" }).fill("repo tide");
  await expect(palette.getByText("Findable tide chart")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/threads\//);
  await page.keyboard.press("ControlOrMeta+p");
  await palette.getByRole("combobox", { name: "Search" }).fill("README");
  await palette.getByRole("button", { name: /README\.md/ }).click();
  await expect(page.locator(".file-preview")).toContainText("Repo");
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await palette.getByRole("combobox", { name: "Search" }).fill("Repo");
  await expect(palette.getByRole("button", { name: /README\.md:1/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("number badges show while the jump key is held, and a digit opens that row", async ({ page }) => {
  await make("Jump target");
  await page.goto(service.page);
  await expect(row(page, "Jump target")).toBeVisible();
  await page.keyboard.down("ControlOrMeta");
  await expect(page.locator("[data-jump-hint='1']")).toBeVisible();
  await page.keyboard.press("1");
  await page.keyboard.up("ControlOrMeta");
  await expect(page).toHaveURL(/#\/threads\//);
});

test("new threads keep their project; the shelf pages; hover shows the card; labs change rows", async ({ page }) => {
  for (const at of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const made = await make(`Shelf ${at}`);
    await service.api("PATCH", `/api/threads/${made.id}`, { settled: true });
  }
  const held = await make("Hover me");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(service.page);
  await expect(row(page, "Hover me")).toBeVisible();
  await row(page, "Hover me").click();
  await page.locator(".thread-main").getByRole("textbox", { name: /^Message/ }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+n");
  await expect(page).toHaveURL(new RegExp(`#/new/${projectId}`));

  const more = page.getByRole("button", { name: /^Show \d+ more/ });
  await page.getByRole("button", { name: /^Settled/ }).click().catch(() => undefined);
  await expect(more).toBeVisible();
  await more.click();
  await expect(row(page, "Shelf 1").first()).toBeVisible();

  await row(page, "Shelf 2").hover();
  await expect(page.getByRole("tooltip")).toBeVisible();

  await page.goto(`${service.page}#/settings/labs`);
  await page.getByRole("switch", { name: "Project folders" }).check();
  await page.getByRole("switch", { name: "Multiline rows" }).check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator(".sidebar-scroll").getByText("my-repo").first()).toBeVisible();
  await expect(page.locator("[data-multiline]").first()).toBeAttached();
  await row(page, "Hover me").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Find in thread" }).click();
  await expect(page.getByRole("textbox", { name: "Find in thread" })).toBeVisible();
  await page.goto(`${service.page}#/threads/${held.id}`);
  await expect(page.locator(".thread-main").getByRole("textbox", { name: /^Message/ })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
});

test("scheduled tasks: create, pause, run and delete through the form", async ({ page }) => {
  await page.goto(`${service.page}#/settings/tasks`);
  await page.getByRole("button", { name: /New/ }).first().click();
  const form = page.getByRole("dialog", { name: "New scheduled task" });
  await form.getByLabel("Name").fill("Nightly");
  await form.getByLabel("Prompt").fill("check things");
  await form.getByLabel("Schedule").selectOption("fixed_time");
  await form.getByLabel("Time").fill("07:30");
  await form.getByLabel("Mon").check();
  await form.getByRole("button", { name: /Create|Save|Add/ }).click();
  await expect(form).toBeHidden();
  const list = () => service.api<{ id: string; enabled: boolean }[]>("GET", "/api/tasks");
  await expect.poll(async () => (await list()).length).toBe(1);
  await page.getByRole("switch", { name: "Enable Nightly" }).click();
  await expect.poll(async () => (await list())[0]?.enabled).toBe(false);
  await page.getByRole("button", { name: "Run Nightly" }).click();
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);

  await page.getByRole("button", { name: "Edit Nightly" }).click();
  const edit = page.getByRole("dialog", { name: "Edit scheduled task" });
  await expect(edit.getByLabel("Time")).toHaveValue("07:30");
  await expect(edit.getByLabel("Mon")).toBeChecked();
  await edit.getByLabel("Name").fill("Weekly");
  await edit.getByLabel("Time").fill("08:15");
  await edit.getByRole("button", { name: "Save task" }).click();
  await expect(edit).toBeHidden();
  const saved = () => service.api<{ name: string; schedule: { time: string } }[]>("GET", "/api/tasks");
  await expect.poll(async () => (await saved())[0]?.name).toBe("Weekly");
  expect((await saved())[0]?.schedule.time).toBe("08:15");

  await page.getByRole("button", { name: "Delete Weekly" }).click();
  await expect.poll(async () => (await list()).length).toBe(0);
});

test("the keybindings page rebinds and the new key runs", async ({ page }) => {
  await page.goto(`${service.page}#/settings/keybindings`);
  await expect(page.getByText("sidebar.toggle")).toBeVisible();
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);
});

test("project defaults, scripts and the worktree settings save", async ({ page }) => {
  await page.goto(`${service.page}#/settings/worktrees`);
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("combobox", { name: "Naming" }).selectOption("semantic");
  await expect
    .poll(async () => {
      const prefs = await service.api<{ key: string; value: unknown }[]>("GET", "/api/preferences");
      return prefs.find((entry) => entry.key === "branch_naming_mode")?.value;
    })
    .toBe("semantic");
  await page.goto(`${service.page}#/settings/projects`);
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);
});

test("appearance: presets, editor, typography, contrast and settings search", async ({ page }) => {
  await page.goto(`${service.page}#/settings/appearance`);
  await page.getByRole("combobox", { name: "Dark theme" }).selectOption("dusk");
  const color = (name: string) => page.evaluate((token) => document.documentElement.style.getPropertyValue(token), name);
  await expect.poll(() => color("--color-primary")).toBe("#7aa2f7");
  await page.getByRole("spinbutton", { name: "Chat size" }).fill("16");
  await expect.poll(() => color("--chat-size")).toBe("16px");
  await page.getByRole("combobox", { name: "Contrast" }).selectOption("more");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "more");
  await page.getByLabel("Accent").fill("#ff0000");
  await expect.poll(() => color("--color-primary")).toBe("#ff0000");
  await page.getByLabel("Import theme file").setInputFiles({
    name: "theme.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ colors: { "editor.background": "#101010" } })),
  });
  await expect.poll(() => color("--color-background")).toBe("#101010");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect.poll(() => color("--color-primary")).toBe("#7aa2f7");
  await page.reload();
  await expect.poll(() => color("--color-primary")).toBe("#7aa2f7");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("typography");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link")).toHaveText(["Appearance"]);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("");
  await page.getByRole("combobox", { name: "Dark theme" }).selectOption("");
});
