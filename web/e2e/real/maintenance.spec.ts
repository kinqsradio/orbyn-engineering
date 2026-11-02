import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { projectSettingsUrl, send, settled, startProject, threadIdOf, type Service } from "./service";

/** Per-project settings, telemetry addresses and storage cleanup on the real service. */

let service: Service;
let projectId = "";
let collector: Server;

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
  collector = createServer((request, response) => {
    response.statusCode = request.url === "/refuses" ? 403 : 200;
    response.end();
  });
  await new Promise<void>((done) => collector.listen(0, "127.0.0.1", done));
});
test.afterAll(async () => {
  collector.close();
  await service.stop();
});

const project = (key: string) =>
  service
    .api<{ key: string; value: unknown }[]>("GET", `/api/preferences?project_id=${projectId}`)
    .then((list) => list.find((entry) => entry.key === key)?.value);

test("scoped defaults and actions reach new threads while disabled provider admission stays enforced", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  // These saved Core defaults remain supported; the old raw model/provider
  // checkbox project modal is absent from the reference's selected detail.
  await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_permission_mode: "full_access", default_model: "fable" } });
  await page.goto(await projectSettingsUrl(service, projectId, "worktrees"));
  await page.getByLabel("Submodules").selectOption("none");
  await page.goto(await projectSettingsUrl(service, projectId, "source-control"));
  await page.getByRole("switch", { name: "Automatically pull" }).click();
  await page.goto(await projectSettingsUrl(service, projectId));
  const dialog = page.locator(".settings-body");
  await dialog.getByRole("button", { name: "Add action", exact: true }).click();
  const action = page.getByRole("dialog", { name: "Add Action", exact: true });
  await action.getByLabel("Name", { exact: true }).fill("Test");
  await action.getByLabel("Command", { exact: true }).fill("npm test");
  await action.getByRole("button", { name: "Save action", exact: true }).click();
  await expect(action).toHaveCount(0);
  await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { disabled_engines: ["codex"] } });
  await expect.poll(() => project("disabled_engines")).toEqual(["codex"]);
  expect(await project("default_permission_mode")).toBe("full_access");
  expect(await project("worktree_submodules")).toBe("none");
  expect(await project("auto_pull")).toBe(true);
  expect(await project("default_project_scripts")).toEqual([expect.objectContaining({ name: "Test", command: "npm test" })]);

  const thread = await service.api<{ id: string; model: string | null; lifecycle: { permission_mode: string } }>("POST", "/api/threads", {
    project_id: projectId,
    engine: "claude",
    title: "Defaults",
    model: null,
    worktree: null,
    skill_profile: null,
  });
  expect(thread.model).toBe("fable");
  expect(thread.lifecycle.permission_mode).toBe("full_access");
  await expect(
    service.api("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Off", model: null, worktree: null, skill_profile: null }),
  ).rejects.toThrow(/turned off/);
  await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { disabled_engines: [] } });
  await expect.poll(() => project("disabled_engines")).toEqual([]);
});

test("an OTLP address saves per signal and its test says what answered", async ({ page }) => {
  const { port } = collector.address() as AddressInfo;
  await page.goto(`${service.page}#/settings/maintenance`);
  const traces = page.getByLabel("Traces endpoint");
  await traces.fill(`http://127.0.0.1:${port}/v1/traces`);
  await traces.blur();
  await expect(page.locator(".setting-line").filter({ hasText: "Traces" }).getByRole("button", { name: "Test" })).toBeEnabled();
  await page.locator(".setting-line").filter({ hasText: "Traces" }).getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("Reached, 200")).toBeVisible();
  const logs = page.getByLabel("Logs endpoint");
  await logs.fill(`http://127.0.0.1:${port}/refuses`);
  await logs.blur();
  await expect(page.locator(".setting-line").filter({ hasText: "Logs" }).getByRole("button", { name: "Test" })).toBeEnabled();
  await page.locator(".setting-line").filter({ hasText: "Logs" }).getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("The server answered 403")).toBeVisible();
  await page.getByRole("form", { name: "OpenTelemetry export" }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Restart the server to apply.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Traces endpoint")).toHaveValue(`http://127.0.0.1:${port}/v1/traces`);
});

test("cleanup removes by its rules and reports what happened", async ({ page }) => {
  const folder = join(service.dataDir, "logs");
  mkdirSync(folder, { recursive: true });
  const old = join(folder, "old.log");
  writeFileSync(old, "old");
  const longAgo = new Date(Date.now() - 10 * 86_400_000);
  utimesSync(old, longAgo, longAgo);
  await page.goto(`${service.page}#/settings/maintenance`);
  await page.getByRole("switch", { name: "Delete old rotated logs", exact: true }).click();
  await expect(page.getByLabel("Delete old rotated logs in days")).toBeEnabled();
  await page.getByLabel("Delete old rotated logs in days").fill("5");
  await page.getByLabel("Delete old rotated logs in days").blur();
  await expect
    .poll(async () => (await service.api<{ key: string; value: { logs_after_days?: number } }[]>("GET", "/api/preferences")).find((entry) => entry.key === "storage_cleanup")?.value.logs_after_days)
    .toBe(5);
  const preview = await service.api<{ entries: { path: string; removed: boolean }[] }>("POST", "/api/storage/cleanup?dry_run=true");
  expect(preview.entries).toContainEqual(expect.objectContaining({ path: old, removed: false }));
  expect(existsSync(old)).toBe(true);
  await page.getByRole("button", { name: "Delete now", exact: true }).click();
  await page.getByRole("button", { name: "Last run", exact: true }).click();
  await expect(page.getByRole("list", { name: "Cleanup report" })).toContainText("Removed");
  expect(existsSync(old)).toBe(false);
  await page.reload();
  await page.getByRole("button", { name: "Last run", exact: true }).click();
  await expect(page.getByRole("list", { name: "Cleanup report" })).toContainText("old.log");
});

test("the database notice appears only past 1 GiB reclaimable", async ({ page }) => {
  await page.goto(`${service.page}#/settings/maintenance`);
  await expect(page.getByRole("button", { name: "Repair" })).toBeVisible();
  await expect(page.getByText(/can give back/)).toBeHidden();
  // The service's answer with one field raised, as a database that size takes too long to make.
  await page.route("**/api/diagnostics", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { database: { reclaimable_bytes: number } };
    body.database.reclaimable_bytes = 2 * 1024 ** 3;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(page.getByText(/can give back 2048\.0 MiB/)).toBeVisible();
});

test("Maintenance lists the service's processes and can stop one", async ({ page }) => {
  const { service: own, projectId } = await startProject({ scenes: true });
  try {
    await page.goto(`${own.page}#/new/${projectId}`);
    await send(page, "[hang]");
    await expect(page).toHaveURL(/#\/threads\//);
    const id = threadIdOf(page);
    await expect.poll(async () => (await own.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${id}`)).active_run?.state).toBe("running");
    await page.goto(`${own.page}#/settings/maintenance`);
    const processes = page.getByRole("list", { name: "Processes" });
    await expect(processes.getByText("orbynd", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Recent problems").or(page.getByRole("list", { name: "Recent problems" })).first()).toBeVisible();
    const engine = processes.getByRole("listitem").filter({ hasText: /node/ }).first();
    await engine.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText(/^Stopped /)).toBeVisible();
    await settled(own, id);
    await expect.poll(async () => JSON.stringify(await own.api("GET", "/api/diagnostics"))).not.toContain('"name":"node"');
  } finally {
    await own.stop();
  }
});
