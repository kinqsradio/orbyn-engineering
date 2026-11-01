import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startProject, startService } from "./service";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";

const scripts = async (service: Awaited<ReturnType<typeof startService>>, id: string) =>
  (await service.api<{ key: string; value: unknown }[]>("GET", `/api/preferences?project_id=${id}`)).find((row) => row.key === "default_project_scripts")?.value;

test("the project action form saves metadata, runs real setup and supports edit and delete", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto(`${service.page}#/settings/projects`);
    await page.getByRole("button", { name: "Settings for my-repo", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "my-repo settings", exact: true });
    await settings.getByRole("button", { name: "Add action", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add Action", exact: true });
    await expect(form.getByLabel("Name", { exact: true })).toBeFocused();
    await form.getByLabel("Name", { exact: true }).fill("Setup");
    await form.getByLabel("Command", { exact: true }).fill("echo editor-action-ran > editor-marker.txt");
    await form.getByLabel("Choose icon", { exact: true }).click();
    await form.getByRole("button", { name: "Build", exact: true }).click();
    await form.getByRole("switch", { name: "Run automatically on worktree creation", exact: true }).check();
    await form.getByRole("switch", { name: "Wait for it to finish before the agent starts", exact: true }).check();
    await form.getByRole("switch", { name: "Run in the thread's worktree when the thread settles", exact: true }).check();
    await form.getByLabel("Preview URL (optional)", { exact: true }).fill("http://localhost:5173");
    await form.getByRole("switch", { name: "Open preview automatically when this action runs", exact: true }).check();
    await form.getByRole("button", { name: "Save action", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(() => scripts(service, projectId)).toEqual([expect.objectContaining({ name: "Setup", icon: "build", async: false, run_on_worktree_create: true, run_on_settle: true, preview_url: "http://localhost:5173", auto_open_preview: true })]);
    const thread = await service.api<{ cwd: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Editor setup", worktree: "action-editor" });
    await expect.poll(() => existsSync(join(thread.cwd, "editor-marker.txt"))).toBe(true);
    expect(existsSync(join(service.repo, "orbyn.json"))).toBe(false);
    await settings.getByRole("button", { name: "Edit Setup", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit Action", exact: true });
    await edit.getByLabel("Name", { exact: true }).fill("Build");
    await edit.getByLabel("Command", { exact: true }).fill("echo updated-action");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect.poll(() => scripts(service, projectId)).toEqual([expect.objectContaining({ name: "Build", command: "echo updated-action", icon: "build", async: false, run_on_settle: true })]);
    await settings.getByRole("button", { name: "Edit Build", exact: true }).click();
    await edit.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog", { name: 'Delete action "Build"?', exact: true }).getByRole("button", { name: "Delete action", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect.poll(() => scripts(service, projectId)).toEqual([]);
  } finally { await service.stop(); }
});

test("failed action saves keep the draft and cannot overwrite an external edit", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_project_scripts: [{ name: "Existing", command: "echo original" }] } });
    await page.goto(`${service.page}#/settings/projects`);
    await page.getByRole("button", { name: "Settings for my-repo", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "my-repo settings", exact: true });
    await settings.getByRole("button", { name: "Add action", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add Action", exact: true });
    await form.getByLabel("Name", { exact: true }).fill("Existing");
    await form.getByLabel("Command", { exact: true }).fill("echo retained-draft");
    await form.getByRole("button", { name: "Save action", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("Each script needs a different name.");
    await expect(form.getByLabel("Command", { exact: true })).toHaveValue("echo retained-draft");
    await form.getByLabel("Name", { exact: true }).fill("New action");
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_project_scripts: [{ name: "Existing", command: "echo external" }] } });
    await form.getByRole("button", { name: "Save action", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("Settings changed. Reload this scope before saving.");
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue("New action");
    await expect(form.getByLabel("Command", { exact: true })).toHaveValue("echo retained-draft");
    expect(await scripts(service, projectId)).toEqual([{ name: "Existing", command: "echo external" }]);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("button", { name: "Add action", exact: true })).toBeFocused();
  } finally { await service.stop(); }
});

test("adding an action to Mixed project settings preserves both checkout lists", async ({ page }) => {
  const service = await startService();
  try {
    await service.api("POST", "/api/workspace/setup", {});
    const projects: { id: string; path: string }[] = [];
    for (const name of ["action-one", "action-two"]) {
      const project = await service.api<{ id: string; path: string }>("POST", "/api/projects/create", { name, readme: true });
      execFileSync("git", ["-C", project.path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Owner/Actions.git"], { stdio: "ignore" });
      await service.api("PUT", `/api/projects/${project.id}/preferences`, { values: { default_project_scripts: [{ name, command: `echo ${name}` }] } });
      projects.push(project);
    }
    const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projects[0]?.id));
    expect(group?.members).toHaveLength(2);
    await page.goto(`${service.page}#/settings/projects?project=${encodeURIComponent(group!.key)}`);
    await page.getByRole("button", { name: "Add action", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add Action", exact: true });
    await form.getByLabel("Name", { exact: true }).fill("Shared");
    await form.getByLabel("Command", { exact: true }).fill("echo shared");
    await form.getByRole("button", { name: "Save action", exact: true }).click();
    await expect(form).toHaveCount(0);
    for (const project of projects) {
      await expect.poll(() => scripts(service, project.id)).toEqual([expect.objectContaining({ name: project.path.split(/[\\/]/).pop(), command: `echo ${project.path.split(/[\\/]/).pop()}` }), expect.objectContaining({ name: "Shared", command: "echo shared" })]);
    }
  } finally { await service.stop(); }
});
