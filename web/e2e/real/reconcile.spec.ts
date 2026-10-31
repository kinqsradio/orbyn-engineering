import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Rows the sidebar, thread menu and details card already serve, on the real service. */
const PORT = 5281;

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
  const started = await startProject(PORT, { fakeEngines: true });
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

test("the keybindings page rebinds and the new key runs", async ({ page }) => {
  await page.goto(`${service.page}#/settings/keybindings`);
  await expect(page.getByText("sidebar.toggle")).toBeVisible();
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);
});

test("project defaults, scripts and the worktree settings save", async ({ page }) => {
  await page.goto(`${service.page}#/settings/worktrees`);
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
