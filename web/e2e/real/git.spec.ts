import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Commit, push, pull request and branches through the real service and real Git. */
const PORT = 5284;

let service: Service;
let projectId = "";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const newThread = async (page: import("@playwright/test").Page) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:usage] hello");
  await expect(page).toHaveURL(/#\/threads\//);
  await settled(service, threadIdOf(page));
  return threadIdOf(page);
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject(PORT, { scenes: true, forge: [] }));
  git(service.repo, "config", "user.name", "Test");
  git(service.repo, "config", "user.email", "test@example.com");
});
test.afterAll(() => service.stop());

test("the Git menu commits, pushes and opens a pull request, phase by phase", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await newThread(page);
  writeFileSync(join(service.repo, "change.txt"), "one\n");
  git(service.repo, "switch", "-q", "-c", "feature");

  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("menuitem", { name: "Commit, push and create pull request" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit, push and create pull request" });
  await expect(dialog.getByRole("button", { name: "Commit, push and create pull request" })).toBeDisabled();
  await dialog.getByLabel("Commit message").fill("Add the change");
  await dialog.getByLabel("Pull request title").fill("Add the change");
  await dialog.getByLabel("Description").fill("Why it matters");
  await dialog.getByLabel("Base branch").selectOption("main");
  await dialog.getByRole("button", { name: "Commit, push and create pull request" }).click();
  const phases = dialog.getByRole("list", { name: "Result" }).getByRole("listitem");
  await expect(phases).toHaveCount(3);
  await expect(phases.nth(2).getByRole("link")).toHaveAttribute("href", "https://github.com/o/r/pull/100");
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();

  expect(git(service.repo, "log", "-1", "--format=%s")).toBe("Add the change");
  expect(git(service.remote, "rev-parse", "feature")).toBe(git(service.repo, "rev-parse", "HEAD"));
  const created = service.ghCalls().find((call) => call[1] === "create");
  expect(created).toEqual(expect.arrayContaining(["--title", "Add the change", "--body", "Why it matters", "--base", "main"]));
  await expect(page.getByRole("button", { name: "Changes +0 -0" })).toBeVisible();
  const linked = await service.api<{ number: number }[]>("GET", `/api/threads/${threadIdOf(page)}/pulls`);
  expect(linked.map((pull) => pull.number)).toEqual([100]);
  git(service.repo, "switch", "-q", "main");
});

test("a phase that fails stops the rest and says why", async ({ page }) => {
  await newThread(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("menuitem", { name: "Commit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Commit" });
  await dialog.getByLabel("Commit message").fill("Nothing to say");
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  const phase = dialog.getByRole("list", { name: "Result" }).getByRole("listitem");
  await expect(phase).toHaveCount(1);
  await expect(phase.getByRole("img", { name: "Failed" })).toBeVisible();
});

test("the branch row searches, creates and switches", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await newThread(page);
  await page.getByRole("button", { name: /^Branch main/ }).click();
  const dialog = page.getByRole("dialog", { name: "Switch branch" });
  await expect(dialog.getByLabel("Current branch")).toBeVisible();
  await dialog.getByLabel("Search branches").fill("topic");
  await dialog.getByRole("button", { name: "Create topic" }).click();
  await expect(dialog).toBeHidden();
  expect(git(service.repo, "branch", "--show-current")).toBe("topic");

  await page.getByRole("button", { name: /^Branch / }).click();
  const again = page.getByRole("dialog", { name: "Switch branch" });
  await again.getByRole("button", { name: "main", exact: true }).click();
  await expect(again).toBeHidden();
  expect(git(service.repo, "branch", "--show-current")).toBe("main");
});

test("a response restores the files from before it, and a shared folder refuses", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await newThread(page);
  const file = join(service.repo, "README.md");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, "changed after the turn\n");
  const action = page.getByRole("button", { name: "Restore files to before this response" }).last();
  await page.getByText("Counted.").last().hover();
  await action.click();
  const dialog = page.getByRole("dialog", { name: "Restore files?" });
  await dialog.getByRole("button", { name: "Restore files" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/other thread|shares/);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(readFileSync(file, "utf8")).toBe("changed after the turn\n");
  writeFileSync(file, before);
});

test("in a thread of its own the files go back, and the restore can be undone", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const thread = await service.api<{ id: string; cwd: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: engines.find((engine) => engine.id === "codex")?.id,
    title: "Restores alone",
    model: null,
    worktree: "restores",
    skill_profile: null,
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await send(page, "[scene:usage] hello");
  await settled(service, thread.id);
  const file = join(thread.cwd, "README.md");
  const added = join(thread.cwd, "new.txt");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, "changed after the turn\n");
  writeFileSync(added, "added\n");
  await page.getByText("Counted.").hover();
  await page.getByRole("button", { name: "Restore files to before this response" }).click();
  await page.getByRole("dialog", { name: "Restore files?" }).getByRole("button", { name: "Restore files" }).click();
  await expect(page.getByRole("dialog", { name: "Restore files?" })).toBeHidden();
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(existsSync(added)).toBe(false);
});

test("edit from here rewinds with or without the files", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const thread = await service.api<{ id: string; cwd: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: engines.find((engine) => engine.id === "codex")?.id,
    title: "Rewinds",
    model: null,
    worktree: "rewinds",
    skill_profile: null,
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await send(page, "[scene:usage] first ask");
  await settled(service, thread.id);
  const file = join(thread.cwd, "README.md");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, "changed by the turn\n");
  await page.locator(".msg-user").last().hover();
  await page.getByRole("button", { name: "Edit from here" }).last().click();
  const dialog = page.getByRole("dialog", { name: "Edit from here?" });
  await dialog.getByLabel("Also restore files to this point").check();
  await dialog.getByRole("button", { name: "Rewind" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("textbox", { name: /^Message/ })).toHaveValue("[scene:usage] first ask");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("publish creates the remote for a project that has none", async ({ page }) => {
  const project = await service.api<{ id: string }>("POST", "/api/projects/add", { path: service.folder });
  git(service.folder, "init", "-q", "-b", "main");
  writeFileSync(join(service.folder, "a.txt"), "a\n");
  git(service.folder, "add", ".");
  git(service.folder, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "First");
  await service.api("POST", `/api/projects/${project.id}/trust`);
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: project.id,
    engine: engines.find((engine) => engine.id === "codex")?.id,
    title: "Publish me",
    model: null,
    worktree: null,
    skill_profile: null,
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("menuitem", { name: "Publish repository" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish repository" });
  await dialog.getByLabel("Repository name").fill("my-new-repo");
  await dialog.getByRole("button", { name: "Publish" }).click();
  await expect(dialog).toBeHidden();
  const call = service.ghCalls().find((args) => args[0] === "repo");
  expect(call).toEqual(["repo", "create", "my-new-repo", "--private", "--source", ".", "--push"]);
});
