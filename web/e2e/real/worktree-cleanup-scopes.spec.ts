import { expect, test } from "@playwright/test";
import { startProject } from "./service";

const TITLE = "Automatic worktree cleanup";

test("switching cleanup on captures the inherited legacy age for the selected project", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { storage_cleanup: { worktree_settled_after_days: 12 }, worktree_cleanup: {} } });
    const catalog = await service.api<{ groups: { key: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/worktrees?project=${encodeURIComponent(group.key)}`);
    const select = page.getByRole("combobox", { name: TITLE, exact: true });
    await expect(select).toHaveValue("on");
    await expect(page.getByRole("spinbutton", { name: `${TITLE}: days`, exact: true })).toHaveValue("12");
    const stored = async () => (await service.api<{ key: string; value: unknown }[]>("GET", `/api/preferences?project_id=${projectId}`)).find((entry) => entry.key === "worktree_cleanup")!.value;
    await select.selectOption("off");
    await expect.poll(stored).toMatchObject({ mode: "off" });
    // Turning it back on starts from the 7 days the field offers; the inherited legacy age only shows while nothing is set.
    await select.selectOption("on");
    await expect.poll(stored).toMatchObject({ mode: "custom", rules: { settled_after_days: 7 } });
  } finally { await service.stop(); }
});

test("worktree cleanup uses project Off, On and Inherit without changing environment rules", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { worktree_cleanup: { mode: "custom", rules: { settled_after_days: 12, forward: "environment" } } } });
    const catalog = await service.api<{ groups: { key: string; label: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/worktrees?project=${encodeURIComponent(group.key)}`);
    const select = page.getByRole("combobox", { name: TITLE, exact: true });
    const preference = async (project?: string) => (await service.api<{ key: string; value: unknown; source: string }[]>("GET", `/api/preferences${project ? `?project_id=${project}` : ""}`))
      .find((entry) => entry.key === "worktree_cleanup")!;
    await expect(select).toHaveValue("on");
    await select.selectOption("off");
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "off" });
    await expect(select).toHaveValue("off");
    expect((await preference()).value).toEqual({ mode: "custom", rules: { settled_after_days: 12, forward: "environment" } });
    await select.selectOption("on");
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "custom", rules: { settled_after_days: 7 } });
    const days = page.getByRole("spinbutton", { name: `${TITLE}: days`, exact: true });
    await days.fill("3"); await days.press("Enter");
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "custom", rules: { settled_after_days: 3 } });
    await page.screenshot({ path: info.outputPath("project-worktree-cleanup.png") });
    await page.getByRole("button", { name: `Reset ${TITLE} to default`, exact: true }).click();
    await expect.poll(async () => (await preference(projectId)).source).toBe("global");
    expect((await preference()).value).toEqual({ mode: "custom", rules: { settled_after_days: 12, forward: "environment" } });
  } finally { await service.stop(); }
});
