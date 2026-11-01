//! Retention scope/draft ownership against real orbynd and disposable data only.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";
import type { ScopedPreferencesResult } from "../../src/generated/ScopedPreferencesResult";
import { startProject, type Service } from "./service";

const INITIAL = { logs_after_days: 8, browser_artifacts_after_days: 10, opaque: { keep: true } };
const logs = (page: Page) => page.getByRole("spinbutton", { name: "Delete old rotated logs in days", exact: true });
const artifacts = (page: Page) => page.getByRole("spinbutton", { name: "Delete old browser artifacts in days", exact: true });
const snapshot = (service: Service) => service.api<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: {}, keys: ["storage_cleanup"] });
const saved = async (service: Service) => (await snapshot(service)).rows.find((row) => row.key === "storage_cleanup")?.value;
async function fixture() {
  const { service, projectId } = await startProject();
  await service.api("PUT", "/api/preferences", { values: { storage_cleanup: INITIAL } });
  // Legacy project rows remain durable, but this environment form must never activate them.
  await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { storage_cleanup: { logs_after_days: 1, opaque: "legacy-project" } } });
  const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
  const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId));
  if (!group) throw new Error("fixture group missing");
  return { service, projectId, group };
}
async function externalEdit(service: Service, patch: Record<string, unknown>) {
  const current = await snapshot(service);
  const row = current.rows.find((entry) => entry.key === "storage_cleanup");
  if (!row) throw new Error("cleanup row missing");
  await service.api("PUT", "/api/settings/preferences", { scope: {}, membership_version: current.catalog.version,
    if_match: { storage_cleanup: row.revision }, edits: { storage_cleanup: { op: "set", value: patch } } });
}

test("cleanup is environment-only and changes only its touched rule", async ({ page }, info) => {
  const { service, projectId, group } = await fixture();
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
      await expect(page.getByText("Choose one environment to configure its telemetry exports.")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Artifacts and logs", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete now", exact: true })).toHaveCount(0);
    }
    expect(await saved(service)).toEqual(INITIAL);
    expect(mutations).toEqual([]);
    await page.goto(`${service.page}#/settings/maintenance`);
    await expect(logs(page)).toHaveValue("8");
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Worktrees, days after settling", { exact: true })).toHaveCount(0);
    await logs(page).fill("5");
    await logs(page).press("Enter");
    await expect.poll(() => saved(service)).toEqual({ ...INITIAL, logs_after_days: 5 });
    await expect(logs(page)).toBeEnabled();
    await page.getByRole("switch", { name: "Delete old rotated logs", exact: true }).click();
    await expect(logs(page)).toHaveCount(0);
    await expect.poll(() => saved(service)).toEqual({ ...INITIAL, logs_after_days: null });
    await expect(page.getByRole("switch", { name: "Delete old rotated logs", exact: true })).toBeEnabled();
    await page.getByRole("switch", { name: "Delete old rotated logs", exact: true }).click();
    await expect(logs(page)).toHaveValue("8");
    await expect.poll(() => saved(service)).toEqual(INITIAL);
    expect(mutations).toEqual([5, null, 8].map((value) => expect.objectContaining({ scope: {}, membership_version: expect.any(String),
      if_match: { storage_cleanup: expect.any(String) }, edits: { storage_cleanup: { op: "set", value: { logs_after_days: value } } } })));
    expect(legacyWrites).toEqual([]);
    const legacy = await service.api<{ key: string; project_id: string | null; value: unknown }[]>("GET", `/api/preferences?project_id=${projectId}`);
    expect(legacy.find((entry) => entry.key === "storage_cleanup")?.value).toEqual({ logs_after_days: 1, opaque: "legacy-project" });
    await page.getByRole("heading", { name: "Artifacts and logs", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("environment-cleanup.png") });
    await page.getByRole("button", { name: "Delete now", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("environment-cleanup-action.png") });
  } finally { await service.stop(); }
});

test("stale retention edits keep the draft and preserve concurrent fields", async ({ page }) => {
  const { service } = await fixture();
  try {
    await page.goto(`${service.page}#/settings/maintenance`);
    await expect(logs(page)).toHaveValue("8");
    await artifacts(page).fill("11");
    await artifacts(page).fill("10"); // Restoring a field relinquishes that draft.
    await logs(page).fill("5");
    await externalEdit(service, { logs_after_days: null, browser_artifacts_after_days: 21, opaque: { keep: "external" } });
    const conflict = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/preferences");
    await logs(page).blur();
    expect((await conflict).status()).toBe(409);
    await expect(logs(page)).toHaveValue("5");
    await expect(artifacts(page)).toHaveValue("21");
    await expect(page.getByRole("switch", { name: "Delete old rotated logs", exact: true })).not.toBeChecked();
    expect(await saved(service)).toEqual({ ...INITIAL, logs_after_days: null, browser_artifacts_after_days: 21, opaque: { keep: "external" } });
    await expect(logs(page)).toBeEnabled();
    await expect(page.getByRole("button", { name: "Delete now", exact: true })).toBeDisabled();
    await logs(page).focus();
    await logs(page).press("Enter");
    await expect.poll(() => saved(service)).toEqual({ logs_after_days: 5, browser_artifacts_after_days: 21, opaque: { keep: "external" } });
    await expect(page.getByRole("button", { name: "Delete now", exact: true })).toBeEnabled();
  } finally { await service.stop(); }
});

test("a delayed cleanup setting response cannot replace a new scope draft", async ({ page }) => {
  const { service, group } = await fixture();
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
    await logs(page).fill("5");
    await logs(page).blur();
    await written;
    await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
    await page.getByRole("menuitemradio", { name: group.label, exact: true }).click();
    await expect(logs(page)).toHaveCount(0);
    await page.getByRole("button", { name: `Project scope: ${group.label}`, exact: true }).click();
    await page.getByRole("menuitemradio", { name: "All projects", exact: true }).click();
    await expect(logs(page)).toHaveValue("5");
    await logs(page).fill("12");
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(logs(page)).toHaveValue("12");
    expect(await saved(service)).toEqual({ ...INITIAL, logs_after_days: 5 });
    await logs(page).press("Enter");
    await expect.poll(() => saved(service)).toEqual({ ...INITIAL, logs_after_days: 12 });
  } finally { release(); await service.stop(); }
});


test("a delayed deletion response cannot replace a later environment report", async ({ page }) => {
  const { service, group } = await fixture();
  const folder = join(service.dataDir, "logs");
  mkdirSync(folder, { recursive: true });
  const expired = (name: string) => {
    const path = join(folder, name);
    writeFileSync(path, "disposable cleanup fixture");
    const old = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(path, old, old);
    return path;
  };
  const firstFile = expired("first-private.log");
  let release = () => {};
  let committed = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const written = new Promise<void>((resolve) => { committed = resolve; });
  let first = true;
  const oldResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/storage/cleanup");
  await page.route("**/api/storage/cleanup", async (route) => {
    if (route.request().method() !== "POST" || !first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch();
    committed();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${service.page}#/settings/maintenance`);
    await page.getByRole("button", { name: "Delete now", exact: true }).click();
    await written;
    expect(existsSync(firstFile)).toBe(false);
    await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
    await page.getByRole("menuitemradio", { name: group.label, exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete now", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: `Project scope: ${group.label}`, exact: true }).click();
    await page.getByRole("menuitemradio", { name: "All projects", exact: true }).click();
    const secondFile = expired("second-private.log");
    await page.getByRole("button", { name: "Delete now", exact: true }).click();
    await expect.poll(() => existsSync(secondFile)).toBe(false);
    await expect(page.getByRole("button", { name: "Delete now", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Last run", exact: true }).click();
    const report = page.getByRole("list", { name: "Cleanup report" });
    await expect(report).toContainText("second-private.log");
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(report).toContainText("second-private.log");
    await expect(report).not.toContainText("first-private.log");
  } finally { release(); await service.stop(); }
});


test("Delete now reflects explicit worktree policy and preserves legacy isolation", async ({ page }) => {
  const { service, projectId } = await fixture();
  const button = page.getByRole("button", { name: "Delete now", exact: true });
  const seed = async (environment: unknown, project: unknown, legacyAge: number | null = 0) => {
    await service.api("PUT", "/api/preferences", { values: { storage_cleanup: { logs_after_days: null, browser_artifacts_after_days: null,
      worktree_settled_after_days: legacyAge }, worktree_cleanup: environment } });
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { worktree_cleanup: project,
      storage_cleanup: { worktree_settled_after_days: 0, logs_after_days: 1 } } });
    await page.goto(`${service.page}#/settings/maintenance`);
    await page.reload();
    await expect(page.getByRole("switch", { name: "Delete old rotated logs", exact: true })).toBeVisible();
  };
  try {
    await seed({ mode: "off" }, {});
    await expect(button).toBeDisabled(); // Explicit environment Off suppresses legacy global0.
    await seed({ mode: "off" }, { mode: "custom", rules: { settled_after_days: 0 } });
    await expect(button).toBeEnabled(); // A project can enable immediate cleanup independently.
    const switchControl = page.getByRole("switch", { name: "Delete old rotated logs", exact: true });
    await switchControl.click();
    await expect(logs(page)).toHaveValue("8");
    await expect(switchControl).toBeEnabled();
    await switchControl.click();
    await expect(logs(page)).toHaveCount(0);
    await expect(button).toBeEnabled(); // A retention patch must preserve the other queried policy row.
    await seed({ mode: "off" }, { mode: "off" });
    await expect(button).toBeDisabled();
    await seed({ mode: "custom", rules: { settled_after_days: null } }, {});
    await expect(button).toBeDisabled(); // Custom Off also suppresses legacy global0.
    await seed({}, {});
    await expect(button).toBeEnabled(); // Empty environment policy preserves global0 runtime semantics.
    await seed({}, {}, null);
    await expect(button).toBeDisabled(); // Legacy project storage_cleanup rows do not activate cleanup.
  } finally { await service.stop(); }
});
