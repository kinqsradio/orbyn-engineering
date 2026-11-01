import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startProject, type Service } from "./service";

/** Diff and file surfaces reading a real checkout through the real service. */

let service: Service;
let projectId = "";
let threadId = "";

const git = (...args: string[]) => execFileSync("git", args, { cwd: service.repo, stdio: "ignore" });
const write = (name: string, text: string) => writeFileSync(join(service.repo, name), text);

test.beforeAll(async () => {
  const started = await startProject({ fakeEngines: true });
  service = started.service;
  projectId = started.projectId;
  mkdirSync(join(service.repo, "tests"));
  write("notes.md", "# Notes\n\nSome **bold** text.\n");
  write("data.csv", 'name,count\n"Moon, the",1\nMars,2\n');
  write("page.html", "<h1>Page</h1><script>window.parent.document.title='pwned'</script>");
  write("flow.mmd", "graph TD\n  A --> B\n");
  write("book.ipynb", JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# Cell title"] }, { cell_type: "code", source: ["print(1)"], outputs: [{ text: "1\n" }] }] }));
  write("tests/a.test.ts", "one\n");
  write("spaced.txt", "alpha beta\n");
  git("add", ".");
  git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "Second commit");
  write("README.md", "# Repo changed\n");
  write("tests/a.test.ts", "two\n");
  write("spaced.txt", "alpha   beta\n");
  write("fresh.txt", "new\n");
  git("add", "fresh.txt");
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: started.engines[0]?.id,
    model: null,
    title: "Surfaces",
    worktree: null,
    skill_profile: null,
  });
  threadId = thread.id;
});
test.afterAll(() => service.stop());

test("the diff surface: status, tests filter, find, split, whitespace, collapse, copy, commit source", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${threadId}`);
  await page.getByRole("button", { name: /^Changes/ }).click();
  await expect(page.locator("[data-diff-file='README.md'] .diff-status")).toHaveText("M");
  await expect(page.locator("[data-diff-file='fresh.txt'] .diff-status")).toHaveText("A");

  await page.getByLabel("Hide tests").check();
  await expect(page.locator("[data-diff-file='tests/a.test.ts']")).toHaveCount(0);
  await page.getByLabel("Hide tests").uncheck();

  await page.getByRole("searchbox", { name: "Find in diff" }).fill("repo changed");
  await expect(page.locator(".diff-find output")).toHaveText("1 match");
  await expect(page.locator(".patch-line[data-hit]").first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Find in diff" }).fill("");

  await page.getByLabel("Split").check();
  await expect(page.locator(".patch-split").first()).toBeVisible();
  await page.getByLabel("Split").uncheck();

  await page.getByLabel("Ignore whitespace").check();
  await expect(page.locator("[data-diff-file='spaced.txt'] .patch-add")).toHaveCount(0);
  await page.getByLabel("Ignore whitespace").uncheck();

  await page.getByLabel("Collapse files").check();
  await expect(page.locator(".patch")).toHaveCount(0);
  await page.getByLabel("Collapse files").uncheck();

  await page.getByRole("button", { name: "Copy path README.md" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("README.md");

  await page.getByRole("radiogroup", { name: "Diff source" }).getByRole("radio", { name: "Commit" }).click();
  await expect(page.getByRole("combobox", { name: "Commit" })).toContainText("Second commit");
  await expect(page.locator("[data-diff-file='notes.md']")).toBeVisible();
});

test("the file picker works before saved keybindings arrive", async ({ page }) => {
  let releaseKeybindings = () => {};
  const keybindingsReady = new Promise<void>((resolve) => { releaseKeybindings = resolve; });
  await page.route("**/api/keybindings", async (route) => {
    await keybindingsReady;
    await route.continue();
  });
  try {
    await page.goto(`${service.page}#/threads/${threadId}`);
    await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox", { name: "Search" }).fill("notes.md");
    await palette.getByRole("button", { name: /notes.md/ }).click();
    await expect(page.locator(".file-preview strong")).toHaveText("bold");
  } finally {
    releaseKeybindings();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("files preview by kind, keep the source, and save safely", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${threadId}`);
  const open = async (name: string) => {
    await page.keyboard.press("ControlOrMeta+p");
    const box = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox", { name: "Search" });
    await box.fill(name);
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("button", { name: new RegExp(name) }).click();
  };
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();

  await open("notes.md");
  await expect(page.locator(".file-preview strong")).toHaveText("bold");
  await page.getByRole("radio", { name: "Source" }).click();
  await expect(page.locator(".file-source")).toContainText("**bold**");

  await page.getByRole("radio", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Edit notes.md" }).fill("# Edited\n");
  write("notes.md", "# Changed elsewhere\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "changed on disk" })).toBeVisible();
  expect(readFileSync(join(service.repo, "notes.md"), "utf8")).toBe("# Changed elsewhere\n");

  await page.getByRole("button", { name: "Files" }).first().click();
  await open("data.csv");
  await expect(page.locator(".file-table td").first()).toHaveText("Moon, the");

  await page.getByRole("button", { name: "Files" }).first().click();
  await open("flow.mmd");
  await expect(page.locator(".md-diagram svg")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Files" }).first().click();
  await open("book.ipynb");
  await expect(page.locator(".file-notebook h2")).toHaveText("Cell title");

  await page.getByRole("button", { name: "Files" }).first().click();
  await open("page.html");
  await expect(page.frameLocator("iframe.file-frame").getByRole("heading", { name: "Page" })).toBeVisible();
  await expect(page).not.toHaveTitle("pwned");
});

test("settings rows for background work and providers save", async ({ page }) => {
  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("combobox", { name: "Activity profile" }).selectOption("saver");
  await page.getByRole("textbox", { name: "Base directory" }).fill("/tmp/projects");
  await page.getByRole("textbox", { name: "Base directory" }).blur();
  await expect
    .poll(async () => {
      const prefs = await service.api<{ key: string; value: unknown }[]>("GET", "/api/preferences");
      return [prefs.find((entry) => entry.key === "background_activity_profile")?.value, prefs.find((entry) => entry.key === "add_project_base_directory")?.value];
    })
    .toEqual(["saver", "/tmp/projects"]);
});
