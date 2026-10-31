import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startProject, type Service } from "./service";

/** Per-project settings, telemetry addresses and storage cleanup on the real service. */
const PORT = 5287;

let service: Service;
let projectId = "";
let collector: Server;

test.beforeAll(async () => {
  ({ service, projectId } = await startProject(PORT, { fakeEngines: true }));
  collector = createServer((request, response) => {
    response.statusCode = request.url === "/refuses" ? 403 : 200;
    response.end();
  });
  await new Promise<void>((done) => collector.listen(0, "127.0.0.1", done));
});
test.afterAll(() => {
  collector.close();
  service.stop();
});

const project = (key: string) =>
  service
    .api<{ key: string; value: unknown }[]>("GET", `/api/preferences?project_id=${projectId}`)
    .then((list) => list.find((entry) => entry.key === key)?.value);

test("a project sets its own defaults and turns a provider off", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.goto(`${service.page}#/settings/projects`);
  await page.getByRole("button", { name: "Settings for my-repo" }).click();
  const dialog = page.getByRole("dialog", { name: "my-repo settings" });
  await dialog.getByLabel("Default permissions").selectOption("full_access");
  await dialog.getByLabel("Submodules").selectOption("skip");
  await dialog.getByRole("switch", { name: "Pull the default branch automatically" }).click();
  await dialog.getByLabel("Default model").fill("fable");
  await dialog.getByLabel("Default model").blur();
  await dialog.getByLabel("Project scripts").fill("Test: npm test");
  await dialog.getByLabel("Project scripts").blur();
  await dialog.getByRole("checkbox", { name: "Codex" }).click();
  await expect.poll(() => project("disabled_engines")).toEqual(["codex"]);
  expect(await project("default_permission_mode")).toBe("full_access");
  expect(await project("worktree_submodules")).toBe("skip");
  expect(await project("auto_pull")).toBe(true);
  expect(await project("default_project_scripts")).toEqual([{ name: "Test", command: "npm test" }]);

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
  await dialog.getByRole("checkbox", { name: "Codex" }).click();
  await expect.poll(() => project("disabled_engines")).toEqual([]);
});

test("an OTLP address saves per signal and its test says what answered", async ({ page }) => {
  const { port } = collector.address() as AddressInfo;
  await page.goto(`${service.page}#/settings/maintenance`);
  const traces = page.getByLabel("Traces address");
  await traces.fill(`http://127.0.0.1:${port}/v1/traces`);
  await traces.blur();
  await expect(page.locator(".setting-line").filter({ hasText: "Traces" }).getByRole("button", { name: "Test" })).toBeEnabled();
  await page.locator(".setting-line").filter({ hasText: "Traces" }).getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("Reached, 200")).toBeVisible();
  const logs = page.getByLabel("Logs address");
  await logs.fill(`http://127.0.0.1:${port}/refuses`);
  await logs.blur();
  await expect(page.locator(".setting-line").filter({ hasText: "Logs" }).getByRole("button", { name: "Test" })).toBeEnabled();
  await page.locator(".setting-line").filter({ hasText: "Logs" }).getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("The server answered 403")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Traces address")).toHaveValue(`http://127.0.0.1:${port}/v1/traces`);
});

test("cleanup previews, removes by its rules and reports what happened", async ({ page }) => {
  const folder = join(service.dataDir, "logs");
  mkdirSync(folder, { recursive: true });
  const old = join(folder, "old.log");
  writeFileSync(old, "old");
  const longAgo = new Date(Date.now() - 10 * 86_400_000);
  utimesSync(old, longAgo, longAgo);
  await page.goto(`${service.page}#/settings/maintenance`);
  await page.getByLabel("Logs, days").fill("5");
  await page.getByLabel("Logs, days").blur();
  await expect
    .poll(async () => (await service.api<{ key: string; value: { logs_after_days?: number } }[]>("GET", "/api/preferences")).find((entry) => entry.key === "storage_cleanup")?.value.logs_after_days)
    .toBe(5);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("list", { name: "Cleanup report" })).toContainText("Would remove");
  expect(existsSync(old)).toBe(true);
  await page.getByRole("button", { name: "Clean up" }).click();
  await expect(page.getByRole("list", { name: "Cleanup report" })).toContainText("Removed");
  expect(existsSync(old)).toBe(false);
  await page.reload();
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
