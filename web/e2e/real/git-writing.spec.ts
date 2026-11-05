import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectSettingsUrl, startProject, type Service } from "./service";

let service: Service;
let projectId: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test.beforeAll(async () => { ({ service, projectId } = await startProject({ fakeEngines: true, forge: [] })); });
test.afterAll(async () => { await service?.stop(); });

// Every scenario owns a repository, project and thread. No branch, index or
// generated result is inherited from another test.
async function fixture(name: string, remote = false) {
  const cwd = join(service.repo, "..", name); mkdirSync(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "README.md"), "# Initial fixture\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "initial");
  let remotePath = "";
  if (remote) {
    remotePath = join(service.repo, "..", `github.com/o/${name}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remotePath]);
    git(cwd, "remote", "add", "origin", remotePath); git(cwd, "push", "-q", "origin", "main");
  }
  const project = await service.api<{ id: string }>("POST", "/api/projects/add", { path: cwd });
  await service.api("POST", `/api/projects/${project.id}/trust`);
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: project.id, engine: "claude", model: "fake-small", title: name });
  return { cwd, thread, remotePath };
}

test("opening, typing and cancelling never admit generation or change Git", async ({ page }) => {
  const { cwd, thread } = await fixture("writing-cancel");
  writeFileSync(join(cwd, "writing.txt"), "An unsubmitted change\n"); const head = git(cwd, "rev-parse", "HEAD");
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("menuitem", { name: "Commit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Commit", exact: true });
  await expect(dialog.getByText(/Leave text blank to auto-generate/)).toBeVisible();
  await dialog.getByLabel("Commit message").fill("An unsubmitted draft");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(git(cwd, "rev-parse", "HEAD")).toBe(head); expect(git(cwd, "diff", "--cached", "--name-only")).toBe("");
  const audit = await service.api<{ action: string }[]>("GET", `/api/audit?thread_id=${thread.id}`);
  expect(audit.filter((row) => row.action === "engine.one_shot")).toHaveLength(0);
});

test("confirmed blank commit text uses the guarded provider and actual change", async ({ page }) => {
  const { cwd, thread } = await fixture("writing-commit"); writeFileSync(join(cwd, "writing.txt"), "A bounded change é\n");
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("menuitem", { name: "Commit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Commit", exact: true });
  await expect(dialog.getByLabel("Commit message")).toHaveValue("");
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "Done" })).toBeVisible();
  expect(git(cwd, "log", "-1", "--format=%s")).toBe("feat(git): describe the change");
  expect(git(cwd, "status", "--porcelain")).toBe("");
  const audit = await service.api<{ action: string }[]>("GET", `/api/audit?thread_id=${thread.id}`);
  expect(audit.filter((row) => row.action === "engine.one_shot")).toHaveLength(1);
});

test("confirmed blank PR text describes the range and publishes only to explicit doubles", async ({ page }) => {
  const { cwd, thread, remotePath } = await fixture("writing-pull", true);
  git(cwd, "switch", "-qc", "feature"); writeFileSync(join(cwd, "writing.txt"), "A real range change\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "fix: actual code change"); const head = git(cwd, "rev-parse", "HEAD");
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create pull request", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create pull request", exact: true });
  await dialog.getByLabel("Base branch").selectOption("main");
  await expect(dialog.getByLabel("Pull request title")).toHaveValue(""); await expect(dialog.getByLabel("Description")).toHaveValue("");
  await dialog.getByRole("button", { name: "Create pull request", exact: true }).click();
  await expect(dialog.getByRole("link")).toHaveAttribute("href", "https://github.com/o/r/pull/100");
  const created = service.ghCalls().find((call) => call[1] === "create");
  expect(created).toEqual(expect.arrayContaining(["--title", "feat(git): describe the change", "--body", "## Summary\n- Describe the actual diff\n\n## Testing\n- Not run", "--base", "main"]));
  expect(git(cwd, "rev-parse", "HEAD")).toBe(head); expect(git(remotePath, "rev-parse", "feature")).toBe(head);
});

test("writing settings save and inherit through the real service at narrow width", async ({ page }, testInfo) => {
  await page.goto(await projectSettingsUrl(service, projectId, "source-control"));
  const mode = page.getByLabel("Source control writing style");
  await expect(mode).toHaveValue("repo_conventions");
  await mode.selectOption("custom");
  const instructions = page.getByLabel("Custom source control writing instructions");
  await expect(instructions).toBeVisible();
  await instructions.fill("Keep summaries short and include issue IDs");
  const saved = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/preferences");
  await instructions.press("Tab");
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(instructions).toHaveValue("Keep summaries short and include issue IDs");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mode).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("writing-settings.png"), fullPage: true });
  await page.getByRole("button", { name: "Reset Writing style to default" }).click();
  await expect(mode).toHaveValue("repo_conventions");
  await expect(instructions).toHaveCount(0);
});
