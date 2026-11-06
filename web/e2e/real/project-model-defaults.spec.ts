import { expect, test, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { EngineModels } from "../../src/api/types";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";
import { projectSettingsUrl, startProject, settled, type Service } from "./service";

const modelRow = (page: Page) => page.locator(".setting-line").filter({
  has: page.locator(".setting-line-title").filter({ hasText: /^Model$/ }),
});
const values = async (service: Service, project?: string) => Object.fromEntries(
  (await service.api<{ key: string; value: unknown }[]>("GET", project ? `/api/preferences?project_id=${project}` : "/api/preferences"))
    .filter((row) => row.key === "default_engine" || row.key === "default_model").map((row) => [row.key, row.value]),
);
async function selectModel(page: Page, label: string) {
  await modelRow(page).locator("[data-model-trigger]").click();
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await picker.getByRole("button", { name: /^Codex$/ }).click();
  await picker.getByRole("option").filter({ hasText: label }).click();
}

test("a scoped model pick commits the tuple, preserves environment defaults and reaches a new draft thread", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    const catalog = await service.api<EngineModels>("GET", "/api/engines/codex/models");
    const model = catalog.models.find((entry) => entry.id === "fake-small")!;
    expect(model).toBeTruthy();
    await service.api("PUT", "/api/preferences", { values: { default_engine: "codex", default_model: "fake-model" } });
    const before = await values(service);
    const originalReadme = readFileSync(join(service.repo, "README.md"), "utf8");
    await page.goto(await projectSettingsUrl(service, projectId));
    await expect(modelRow(page)).toBeVisible();
    const saved = page.waitForResponse((response) => response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/settings/preferences");
    await selectModel(page, model.label);
    const response = await saved;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().edits).toEqual({
      default_engine: { op: "set", value: "codex" }, default_model: { op: "set", value: "fake-small" },
    });
    await expect.poll(() => values(service, projectId)).toEqual({ default_engine: "codex", default_model: "fake-small" });
    expect(await values(service)).toEqual(before);
    expect(readFileSync(join(service.repo, "README.md"), "utf8")).toBe(originalReadme);
    expect(existsSync(join(service.repo, "orbyn.json"))).toBe(false);
    await page.screenshot({ path: info.outputPath("project-model.png") });
    await page.goto(`${service.page}#/new/${projectId}`);
    const box = page.getByRole("textbox", { name: /^Message/ });
    await expect(page.locator("[data-model-trigger]")).toHaveAccessibleName(model.label);
    await box.fill("model defaults fixture");
    const created = page.waitForResponse((reply) => reply.request().method() === "POST" && new URL(reply.url()).pathname === "/api/threads");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const thread = await (await created).json() as { id: string; engine: string; model: string };
    expect(thread.engine).toBe("codex"); expect(thread.model).toBe("fake-small");
    await settled(service, thread.id);
  } finally { await service.stop(); }
});

test("a real version conflict retains the model choice until explicit reload and retry", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    const catalog = await service.api<EngineModels>("GET", "/api/engines/codex/models");
    const model = catalog.models.find((entry) => entry.id === "fake-small")!;
    await page.goto(await projectSettingsUrl(service, projectId));
    await expect(modelRow(page)).toBeVisible();
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_engine: "codex", default_model: "external-choice" } });
    await selectModel(page, model.label);
    await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Reload", exact: true }) })).toBeVisible();
    expect(await values(service, projectId)).toEqual({ default_engine: "codex", default_model: "external-choice" });
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeDisabled();
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(retry).toBeEnabled();
    expect(await values(service, projectId)).toEqual({ default_engine: "codex", default_model: "external-choice" });
    await retry.click();
    await expect.poll(() => values(service, projectId)).toEqual({ default_engine: "codex", default_model: model.id });
  } finally { await service.stop(); }
});

test("Inherit and environment Reset all preserve defaults and remove only project model overrides", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", "/api/preferences", { values: { default_engine: "codex", default_model: "fake-model" } });
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_engine: "codex", default_model: "fake-small" } });
    await page.goto(await projectSettingsUrl(service, projectId));
    await modelRow(page).getByRole("button", { name: "Inherit", exact: true }).click();
    await expect.poll(() => values(service, projectId)).toEqual(await values(service));
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_engine: "codex", default_model: "fake-small" } });
    await page.goto(`${service.page}#/settings/projects`);
    await expect(modelRow(page).locator("[data-model-trigger]")).toHaveAccessibleName("fake-model");
    await modelRow(page).getByRole("button", { name: "Reset all", exact: true }).click();
    await expect.poll(() => values(service, projectId)).toEqual({ default_engine: "codex", default_model: "fake-model" });
    expect(await values(service)).toEqual({ default_engine: "codex", default_model: "fake-model" });
    await page.setViewportSize({ width: 600, height: 850 });
    await expect(modelRow(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath("environment-model-narrow.png") });
  } finally { await service.stop(); }
});

test("a Mixed project group changes both captured checkouts while a checkout choice stays isolated", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    const peer = await service.api<{ id: string; path: string }>("POST", "/api/projects/create", { name: "model-peer", readme: true });
    for (const path of [service.repo, peer.path]) execFileSync("git", ["-C", path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Owner/Models.git"]);
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_engine: "codex", default_model: "fake-small" } });
    await service.api("PUT", `/api/projects/${peer.id}/preferences`, { values: { default_engine: "codex", default_model: "fake-model" } });
    const scopes = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
    const group = scopes.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    expect(group.members).toHaveLength(2);
    const catalog = await service.api<EngineModels>("GET", "/api/engines/codex/models");
    const small = catalog.models.find((entry) => entry.id === "fake-small")!;
    await page.goto(`${service.page}#/settings/projects?project=${encodeURIComponent(group.key)}`);
    await expect(modelRow(page).getByText("Mixed", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("mixed-model-group.png") });
    expect((await values(service, peer.id)).default_model).toBe("fake-model");
    await selectModel(page, small.label);
    await expect.poll(() => values(service, peer.id)).toEqual({ default_engine: "codex", default_model: "fake-small" });
    expect(await values(service, projectId)).toEqual({ default_engine: "codex", default_model: "fake-small" });
    await page.goto(await projectSettingsUrl(service, peer.id));
    await modelRow(page).getByRole("button", { name: "Automatic", exact: true }).click();
    await expect.poll(() => values(service, peer.id)).toEqual({ default_engine: "", default_model: "" });
    expect(await values(service, projectId)).toEqual({ default_engine: "codex", default_model: "fake-small" });
  } finally { await service.stop(); }
});

test("Escape closes only the model picker inside native modal settings, including from its provider rail", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    for (const focus of ["search", "provider"]) {
      await page.goto(await projectSettingsUrl(service, projectId));
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      await expect(settings).toBeVisible();
      expect(await settings.evaluate((element) => element.matches(":modal"))).toBe(true);
      const trigger = modelRow(page).locator("[data-model-trigger]");
      await trigger.click();
      const picker = settings.getByRole("dialog", { name: "Choose a model" });
      await expect(picker).toBeVisible();
      const search = picker.getByRole("textbox", { name: "Search models" });
      await expect(search).toBeFocused();
      if (focus === "provider") {
        await search.press("Shift+Tab");
        await expect(picker.getByRole("toolbar", { name: "Providers" }).locator("[aria-pressed=true]")).toBeFocused();
      }
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
    }
  } finally { await service.stop(); }
});
