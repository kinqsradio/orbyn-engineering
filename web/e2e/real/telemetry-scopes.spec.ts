//! Scope and draft ownership through the real service; no telemetry is exported.
import { expect, test, type Page } from "@playwright/test";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";
import type { ScopedPreferencesResult } from "../../src/generated/ScopedPreferencesResult";
import { startProject, type Service } from "./service";

const INITIAL = { traces_url: "http://collector.invalid/old-traces", metrics_url: "http://collector.invalid/old-metrics", logs_url: "", directory: "keep-directory", opaque: { keep: true } };
const section = (page: Page) => page.getByRole("heading", { name: "OpenTelemetry export", exact: true }).locator("..");
const form = (page: Page) => page.getByRole("form", { name: "OpenTelemetry export" });
const snapshot = (service: Service) => service.api<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: {}, keys: ["observability"] });
const saved = async (service: Service) => (await snapshot(service)).rows.find((row) => row.key === "observability")?.value;
async function fixture() {
  const { service, projectId } = await startProject();
  await service.api("PUT", "/api/preferences", { values: { observability: INITIAL } });
  const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
  const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId));
  if (!group) throw new Error("fixture group missing");
  const { environment_label: environment } = await service.api<{ environment_label: string }>("GET", "/api/info");
  return { service, projectId, group, environment };
}
async function externalEdit(service: Service, patch: Record<string, unknown>) {
  const current = await snapshot(service);
  const row = current.rows.find((entry) => entry.key === "observability");
  if (!row) throw new Error("telemetry row missing");
  await service.api("PUT", "/api/settings/preferences", { scope: {}, membership_version: current.catalog.version,
    if_match: { observability: row.revision }, edits: { observability: { op: "set", value: patch } } });
}

test("telemetry requires the local environment and saves only an explicit field patch", async ({ page }, info) => {
  const { service, projectId, group, environment } = await fixture();
  const mutations: unknown[] = [];
  const legacyWrites: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/settings/preferences") mutations.push(request.postDataJSON());
    if (path === "/api/preferences") legacyWrites.push(path);
  });
  try {
    const project = `${service.page}#/settings/maintenance?project=${encodeURIComponent(group.key)}`;
    for (const url of [project, `${project}&checkout=${encodeURIComponent(projectId)}`, `${service.page}#/settings/maintenance?project=missing-project`]) {
      await page.goto(url);
      await expect(section(page).getByText("Choose one environment to configure its telemetry exports.")).toBeVisible();
      await expect(form(page)).toHaveCount(0);
      expect(await saved(service)).toEqual(INITIAL);
    }
    await section(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("telemetry-environment-required.png") });
    await section(page).getByRole("button", { name: environment, exact: true }).click();
    const traces = form(page).getByRole("textbox", { name: "Traces endpoint", exact: true });
    await expect(traces).toHaveValue(INITIAL.traces_url);
    await traces.fill("http://collector.invalid/draft-traces");
    await traces.press("Tab");
    expect(await saved(service)).toEqual(INITIAL);
    expect(mutations).toHaveLength(0);
    await form(page).getByRole("button", { name: "Discard", exact: true }).click();
    await expect(traces).toHaveValue(INITIAL.traces_url);
    await traces.fill("http://collector.invalid/new-traces");
    await form(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(form(page).getByText("Saved. Restart the server to apply.")).toBeVisible();
    expect(await saved(service)).toEqual({ ...INITIAL, traces_url: "http://collector.invalid/new-traces" });
    expect(mutations).toEqual([expect.objectContaining({ scope: {}, membership_version: expect.any(String),
      if_match: { observability: expect.any(String) }, edits: { observability: { op: "set", value: { traces_url: "http://collector.invalid/new-traces" } } } })]);
    expect(legacyWrites).toEqual([]);
    await page.screenshot({ path: info.outputPath("telemetry-environment-saved.png") });
  } finally { await service.stop(); }
});

test("a stale telemetry save retains its draft and does not resend a restored field", async ({ page }) => {
  const { service } = await fixture();
  try {
    await page.goto(`${service.page}#/settings/maintenance`);
    const traces = form(page).getByRole("textbox", { name: "Traces endpoint", exact: true });
    const metrics = form(page).getByRole("textbox", { name: "Metrics endpoint", exact: true });
    await expect(traces).toHaveValue(INITIAL.traces_url);
    await traces.fill("http://collector.invalid/restored-draft");
    await traces.fill(INITIAL.traces_url);
    const external = { traces_url: "http://collector.invalid/other-client", opaque: { keep: "other-client" } };
    await externalEdit(service, external);
    await metrics.fill("http://collector.invalid/new-metrics");
    const conflict = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/preferences");
    await form(page).getByRole("button", { name: "Save", exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(metrics).toHaveValue("http://collector.invalid/new-metrics");
    await expect(traces).toHaveValue(external.traces_url);
    expect(await saved(service)).toEqual({ ...INITIAL, ...external });
    await expect(form(page).getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await form(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(form(page).getByText("Saved. Restart the server to apply.")).toBeVisible();
    expect(await saved(service)).toEqual({ ...INITIAL, ...external, metrics_url: "http://collector.invalid/new-metrics" });
  } finally { await service.stop(); }
});

test("a late environment save cannot clear a new draft after scope navigation", async ({ page }) => {
  const { service, group, environment } = await fixture();
  let release = () => {};
  let committed = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const written = new Promise<void>((resolve) => { committed = resolve; });
  let first = true;
  const oldResponse = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/preferences");
  await page.route("**/api/settings/preferences", async (route) => {
    if (route.request().method() !== "PUT" || !first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch();
    committed();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${service.page}#/settings/maintenance`);
    await form(page).getByRole("textbox", { name: "Traces endpoint", exact: true }).fill("http://collector.invalid/authorized-environment-write");
    await form(page).getByRole("button", { name: "Save", exact: true }).click();
    await written;
    await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
    await page.getByRole("menuitemradio", { name: group.label, exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    await section(page).getByRole("button", { name: environment, exact: true }).click();
    const metrics = form(page).getByRole("textbox", { name: "Metrics endpoint", exact: true });
    await metrics.fill("http://collector.invalid/new-owner-draft");
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(metrics).toHaveValue("http://collector.invalid/new-owner-draft");
    await expect(form(page).getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(form(page).getByText("Saved. Restart the server to apply.")).toHaveCount(0);
    expect(await saved(service)).toEqual({ ...INITIAL, traces_url: "http://collector.invalid/authorized-environment-write" });
    await form(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(form(page).getByText("Saved. Restart the server to apply.")).toBeVisible();
    expect(await saved(service)).toEqual({ ...INITIAL, traces_url: "http://collector.invalid/authorized-environment-write", metrics_url: "http://collector.invalid/new-owner-draft" });
  } finally { release(); await service.stop(); }
});
