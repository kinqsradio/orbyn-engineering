import { expect, test } from "@playwright/test";
import { startProject } from "./service";

test("Custom captures the inherited legacy age for the selected project", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { storage_cleanup: { worktree_settled_after_days: 12 }, worktree_cleanup: {} } });
    const catalog = await service.api<{ groups: { key: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/worktrees?project=${encodeURIComponent(group.key)}`);
    const mode = page.getByLabel("Automatic worktree cleanup", { exact: true });
    await expect(mode).toHaveValue("inherit"); await mode.selectOption("custom");
    await expect.poll(async () => (await service.api<{ key: string; value: unknown }[]>("GET", `/api/preferences?project_id=${projectId}`)).find((entry) => entry.key === "worktree_cleanup")!.value)
      .toMatchObject({ mode: "custom", rules: { settled_after_days: 12 } });
  } finally { await service.stop(); }
});

test("worktree cleanup uses project Off, Custom and Inherit without changing environment rules", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { worktree_cleanup: { mode: "custom", rules: { settled_after_days: 12, forward: "environment" } } } });
    const catalog = await service.api<{ groups: { key: string; label: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/worktrees?project=${encodeURIComponent(group.key)}`);
    const mode = page.getByLabel("Automatic worktree cleanup", { exact: true });
    await expect(mode).toHaveValue("inherit");
    const preference = async (project?: string) => (await service.api<{ key: string; value: unknown; source: string }[]>("GET", `/api/preferences${project ? `?project_id=${project}` : ""}`))
      .find((entry) => entry.key === "worktree_cleanup")!;
    await mode.selectOption("custom");
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "custom", rules: { settled_after_days: 12 } });
    await expect(mode).toBeEnabled();
    await mode.selectOption("inherit");
    await expect(mode).toHaveValue("inherit");
    await mode.selectOption("off");
    await expect(mode).toHaveValue("off");
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "off" });
    expect((await preference()).value).toEqual({ mode: "custom", rules: { settled_after_days: 12, forward: "environment" } });
    await mode.selectOption("custom");
    await expect(mode).toHaveValue("custom");
    await page.getByRole("button", { name: "Advanced", exact: true }).last().click();
    const toggle = page.getByRole("switch", { name: "Delete settled worktrees", exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    const days = page.getByRole("spinbutton", { name: "Delete settled worktrees in days", exact: true });
    await expect(days).toHaveValue("8");
    await days.fill("0"); await days.press("Tab");
    await expect.poll(async () => (await preference(projectId)).value).toMatchObject({ mode: "custom", rules: { settled_after_days: 0 } });
    await page.screenshot({ path: info.outputPath("project-worktree-cleanup.png") });
    await mode.selectOption("inherit");
    await expect.poll(async () => (await preference(projectId)).source).toBe("global");
    expect((await preference()).value).toEqual({ mode: "custom", rules: { settled_after_days: 12, forward: "environment" } });
  } finally { await service.stop(); }
});

test("a conflicting worktree age keeps its draft and newer policy fields", async ({ page }) => {
  const { service } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { worktree_cleanup: { mode: "custom", rules: { settled_after_days: 3 } } } });
    await page.goto(`${service.page}#/settings/worktrees`);
    await expect(page.getByRole("heading", { name: "Cleanup", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Advanced", exact: true }).last().click();
    const days = page.getByRole("spinbutton", { name: "Delete settled worktrees in days", exact: true });
    await expect(days).toHaveValue("3");
    await days.fill("0");
    await service.api("PUT", "/api/preferences", { values: { worktree_cleanup: { mode: "custom", rules: { settled_after_days: 5, forward: "newer" }, future: true } } });
    await days.press("Tab");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(days).toHaveValue("0");
    await expect(days).toBeEnabled();
    await days.focus(); await days.press("Tab");
    await expect.poll(async () => (await service.api<{ key: string; value: unknown }[]>("GET", "/api/preferences")).find((entry) => entry.key === "worktree_cleanup")!.value)
      .toEqual({ mode: "custom", rules: { settled_after_days: 0, forward: "newer" }, future: true });
  } finally { await service.stop(); }
});

test("a late project save cannot replace an environment draft", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  let release = () => {};
  let written = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const committed = new Promise<void>((resolve) => { written = resolve; });
  let first = true;
  await page.route("**/api/settings/preferences", async (route) => {
    if (route.request().method() !== "PUT" || !first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch(); written();
    await held; await route.fulfill({ response });
  });
  try {
    const value = { mode: "custom", rules: { settled_after_days: 3 } };
    await service.api("PUT", "/api/preferences", { values: { worktree_cleanup: value } });
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { worktree_cleanup: value } });
    const catalog = await service.api<{ groups: { key: string; label: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    const days = page.getByRole("spinbutton", { name: "Delete settled worktrees in days", exact: true });
    await page.goto(`${service.page}#/settings/worktrees?project=${encodeURIComponent(group.key)}`);
    await expect(page.getByLabel("Automatic worktree cleanup", { exact: true })).toHaveValue("custom");
    await page.getByRole("button", { name: "Advanced", exact: true }).last().click();
    await days.fill("0"); await days.press("Tab"); await committed;
    const response = page.waitForResponse((item) => item.request().method() === "PUT" && new URL(item.url()).pathname === "/api/settings/preferences");
    await page.getByRole("button", { name: `Project scope: ${group.label}`, exact: true }).click();
    await page.getByRole("menuitemradio", { name: "All projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Cleanup", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Advanced", exact: true }).last().click();
    await expect(days).toHaveValue("3"); await days.fill("12");
    release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(days).toHaveValue("12");
    await days.press("Tab");
    await expect.poll(async () => (await service.api<{ key: string; value: unknown }[]>("GET", "/api/preferences")).find((entry) => entry.key === "worktree_cleanup")!.value).toEqual({ mode: "custom", rules: { settled_after_days: 12 } });
  } finally { release(); await service.stop(); }
});
