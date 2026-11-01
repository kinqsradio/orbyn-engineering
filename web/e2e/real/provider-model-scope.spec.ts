import { expect, test } from "@playwright/test";
import { startProject } from "./service";

const initial = [
  { engine: "codex", id: "initial-choice", label: "Initial choice", forward: { keep: true } },
  { engine: "claude", id: "other-engine", label: "Other engine" },
];

test("custom model edits retain their environment target and a conflicting draft", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { custom_models: initial } });
    const catalog = await service.api<{ groups: { key: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/providers?project=${encodeURIComponent(group.key)}`);
    const row = page.locator(".setting-list > li").filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
    await row.getByRole("button", { name: /^Models \(/ }).click();
    const form = row.getByRole("form", { name: "Custom models for Codex", exact: true });
    await expect(form.getByRole("button", { name: "Remove Initial choice", exact: true })).toBeVisible();
    const external = { engine: "codex", id: "external-choice", label: "External choice", forward: "preserve" };
    const externalValues = [...initial, external, null, { unknown_format: ["preserve"] }];
    await service.api("PUT", "/api/preferences", { values: { custom_models: externalValues } });
    const models = async () => (await service.api<{ key: string; value: unknown }[]>("GET", "/api/preferences"))
      .find((entry) => entry.key === "custom_models")!.value;
    await form.getByLabel("Model id", { exact: true }).fill("draft-choice");
    await form.getByLabel("Display name", { exact: true }).fill("Draft choice");
    await form.getByRole("button", { name: "Add model", exact: true }).click();
    await expect.poll(models).toContainEqual(external);
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(form.getByLabel("Model id", { exact: true })).toHaveValue("draft-choice");
    await expect(form.getByRole("button", { name: "Add model", exact: true })).toBeEnabled();
    await form.getByRole("button", { name: "Add model", exact: true }).click();
    await expect.poll(models).toEqual([...externalValues, { engine: "codex", id: "draft-choice", label: "Draft choice" }]);
    const project = await service.api<{ key: string; source: string }[]>("GET", `/api/preferences?project_id=${projectId}`);
    expect(project.find((entry) => entry.key === "custom_models")?.source).toBe("global");
    await page.screenshot({ path: info.outputPath("custom-model-environment.png") });
  } finally { await service.stop(); }
});

test("an unavailable project selection cannot submit a custom model edit", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { custom_models: initial } });
    const catalog = await service.api<{ groups: { key: string; members: { project_id: string }[] }[] }>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await service.api("DELETE", `/api/projects/${projectId}`);
    await page.goto(`${service.page}#/settings/providers?project=${encodeURIComponent(group.key)}`);
    const row = page.locator(".setting-list > li").filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
    await row.getByRole("button", { name: /^Models \(/ }).click();
    const form = row.getByRole("form", { name: "Custom models for Codex", exact: true });
    await expect(page.getByRole("status").filter({ hasText: "This selection is no longer available" })).toBeVisible();
    await expect(form.getByLabel("Model id", { exact: true })).toBeDisabled();
    await expect(form.getByRole("button", { name: "Add model", exact: true })).toBeDisabled();
    const models = (await service.api<{ key: string; value: unknown }[]>("GET", "/api/preferences")).find((entry) => entry.key === "custom_models")!.value;
    expect(models).toEqual(initial);
  } finally { await service.stop(); }
});
