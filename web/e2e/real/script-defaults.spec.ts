import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startProject } from "./service";
import type { ProjectFileView } from "../../src/generated/ProjectFileView";

test("script menus and execution follow project, environment and actual checkout defaults", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    const file = join(service.repo, "orbyn.json");
    const contents = JSON.stringify({ scripts: [{ name: "File script", command: "echo file-script-result" }] });
    writeFileSync(file, contents);
    const made = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Script defaults" });
    const base = `/api/threads/${made.id}`;
    const scripts = () => service.api<ProjectFileView>("GET", `${base}/scripts`);
    const save = (project: boolean, value: unknown) => service.api("PUT", project ? `/api/projects/${projectId}/preferences` : "/api/preferences", { values: { default_project_scripts: value } });
    const environment = [{ name: "Environment script", command: "echo environment-script-result" }];
    const project = [{ name: "Project script", command: "echo project-script-result" }];
    await save(false, environment);
    await save(true, project);
    expect((await scripts()).file?.scripts[0]?.name).toBe("File script");
    expect((await scripts()).scripts[0]?.name).toBe("Project script");
    await page.goto(`${service.page}#/threads/${made.id}`);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByRole("button", { name: "Run a script", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "File script", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Project script", exact: true }).click();
    await expect.poll(async () => {
      const terminals = await service.api<{ id: string; script: string | null }[]>("GET", `${base}/terminals`);
      const terminal = terminals.find((entry) => entry.script === "Project script");
      return terminal ? (await service.api<{ text: string }>("GET", `${base}/terminals/${terminal.id}/scrollback`)).text : "";
    }).toContain("project-script-result");
    await expect(page.getByRole("tab", { name: "Project script", exact: true })).toHaveAttribute("aria-selected", "true");
    await save(true, null);
    expect((await scripts()).scripts[0]?.name).toBe("Environment script");
    await save(false, []);
    expect((await scripts()).scripts).toEqual([]);
    await save(false, null);
    expect((await scripts()).scripts[0]?.name).toBe("File script");
    await expect(save(true, [{ name: "Invalid", command: "" }])).rejects.toThrow(/400/);
    expect((await scripts()).scripts[0]?.name).toBe("File script");
    expect(readFileSync(file, "utf8")).toBe(contents);
    await save(false, [{ name: "Setup", command: "echo setup-script-result > setup-marker.txt", run_on_worktree_create: true }]);
    const worktree = await service.api<{ id: string; cwd: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Checkout scripts", worktree: "script-defaults" });
    await expect.poll(() => existsSync(join(worktree.cwd, "setup-marker.txt"))).toBe(true);
    await expect.poll(() => readFileSync(join(worktree.cwd, "setup-marker.txt"), "utf8")).toContain("setup-script-result");
    await save(false, null);
    writeFileSync(join(worktree.cwd, "orbyn.json"), JSON.stringify({ scripts: [{ name: "Checkout script", command: "echo checkout-script-result" }] }));
    const checkout = await service.api<ProjectFileView>("GET", `/api/threads/${worktree.id}/scripts`);
    expect(checkout.scripts[0]?.name).toBe("Checkout script");
    expect((await scripts()).scripts[0]?.name).toBe("File script");
  } finally { await service.stop(); }
});
