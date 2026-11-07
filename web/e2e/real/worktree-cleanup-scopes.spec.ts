import { expect, test } from "@playwright/test";
import { startProject } from "./service";

const TITLE = "Clean up finished worktrees";

test("switching cleanup on captures the inherited legacy age for the selected project", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { storage_cleanup: { worktree_settled_after_days: 12 }, worktree_cleanup: {} } });
    const catalog = await service.api<{ groups: { key: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/worktrees?project=${encodeURIComponent(group.key)}`);
    const toggle = page.getByRole("switch", { name: TITLE, exact: true });
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Merged or archived, untouched for 12 days", { exact: true })).toBeVisible();
    await toggle.click(); await toggle.click();
    await expect.poll(async () => (await service.api<{ key: string; value: unknown }[]>("GET", `/api/preferences?project_id=${projectId}`)).find((entry) => entry.key === "worktree_cleanup")!.value)
      .toMatchObject({ mode: "custom", rules: { settled_after_days: 12 } });
  } finally { await service.stop(); }
});

test("worktree cleanup uses project Off, On and Inherit without changing environment rules", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { worktree_cleanup: { mode: "custom", rules: { settled_after_days: 12, forward: "environment" } } } });
    const catalog = await service.api<{ groups: { key: string; label: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/worktrees?project=${encodeURIComponent(group.key)}`);
    const toggle = page.getByRole("switch", { name: TITLE, exact: true });
    const preference = async (project?: string) => (await service.api<{ key: string; value: unknown; source: string }[]>("GET", `/api/preferences${project ? `?project_id=${project}` : ""}`))
      .find((entry) => entry.key === "worktree_cleanup")!;
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "off" });
    await expect(toggle).not.toBeChecked();
    expect((await preference()).value).toEqual({ mode: "custom", rules: { settled_after_days: 12, forward: "environment" } });
    await toggle.click();
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "custom", rules: { settled_after_days: 7 } });
    await page.screenshot({ path: info.outputPath("project-worktree-cleanup.png") });
    await page.getByRole("button", { name: `Reset ${TITLE} to default`, exact: true }).click();
    await expect.poll(async () => (await preference(projectId)).source).toBe("global");
    expect((await preference()).value).toEqual({ mode: "custom", rules: { settled_after_days: 12, forward: "environment" } });
  } finally { await service.stop(); }
});
