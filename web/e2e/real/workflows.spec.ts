import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Smaller flows that cross the UI and the service: presets, servers, scripts, editors, stops. */
const FAKE = resolve(import.meta.dirname, "../../../target/debug/orbyn-fake-engine");

let service: Service;
let projectId = "";
let engine = "";

const thread = (title: string, extra: object = {}) =>
  service.api<{ id: string; cwd: string; worktree: { base: string; branch: string } | null }>("POST", "/api/threads", {
    project_id: projectId,
    engine,
    title,
    model: null,
    worktree: null,
    skill_profile: null,
    ...extra,
  });
const row = (page: Page, title: string) => page.locator("li[data-thread-item]").filter({ hasText: title });

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true, forge: true }));
  engine = (await service.api<{ id: string }[]>("GET", "/api/engines")).find((entry) => entry.id === "codex")?.id ?? "";
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("a snooze preset joins the thread menu, and a message wakes a snoozed thread", async ({ page }) => {
  const made = await thread("Snoozy");
  await page.goto(`${service.page}#/settings/threads`);
  await page.getByLabel("Preset name").fill("After lunch");
  await page.getByLabel("Preset minutes").fill("90");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove After lunch" })).toBeVisible();
  await page.goto(`${service.page}#/threads/${made.id}`);
  await page.reload();
  await row(page, "Snoozy").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "After lunch" }).click();
  await expect.poll(async () => (await service.api<{ lifecycle: { snoozed_until: string | null } }>("GET", `/api/threads/${made.id}`)).lifecycle.snoozed_until).not.toBeNull();

  await page.goto(`${service.page}#/threads/${made.id}`);
  await expect(page.getByRole("heading", { name: "Snoozy" })).toBeVisible();
  await send(page, "wake up");
  await settled(service, made.id);
  await expect.poll(async () => (await service.api<{ lifecycle: { snoozed_until: string | null } }>("GET", `/api/threads/${made.id}`)).lifecycle.snoozed_until).toBeNull();
});

test("a snoozed row wakes from its own button", async ({ page }) => {
  const made = await thread("Sleeper");
  const later = new Date(Date.now() + 3_600_000).toISOString();
  await service.api("PATCH", `/api/threads/${made.id}`, { snoozed_until: later });
  await page.goto(service.page);
  await row(page, "Sleeper").hover();
  await row(page, "Sleeper").getByRole("button", { name: "Wake thread now" }).click();
  await expect.poll(async () => (await service.api<{ lifecycle: { snoozed_until: string | null } }>("GET", `/api/threads/${made.id}`)).lifecycle.snoozed_until).toBeNull();
});

test("a server from this checkout is listed and can be stopped", async ({ page }) => {
  const made = await thread("Servers");
  const server = spawn(process.execPath, ["-e", "require('http').createServer((_,r)=>r.end('ok')).listen(0,'127.0.0.1');setTimeout(()=>{},60000)"], { cwd: made.cwd, stdio: "ignore" });
  await expect.poll(async () => (await service.api<unknown[]>("GET", `/api/threads/${made.id}/servers`)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.goto(`${service.page}#/threads/${made.id}`);
  await page.getByRole("button", { name: "Surfaces" }).click();
  await page.getByRole("button", { name: /Browser/ }).last().click();
  await page.getByRole("button", { name: /^Stop localhost:/ }).click();
  await expect.poll(() => server.exitCode ?? server.signalCode, { timeout: 15_000 }).not.toBeNull();
  await expect.poll(async () => (await service.api<unknown[]>("GET", `/api/threads/${made.id}/servers`)).length).toBe(0);
});

test("a project script runs in its own terminal, and a watch-only terminal sends nothing", async ({ page }) => {
  const made = await thread("Scripts");
  writeFileSync(join(made.cwd, "orbyn.json"), JSON.stringify({ scripts: [{ name: "Say hi", command: "echo from-the-script" }] }));
  await page.goto(`${service.page}#/threads/${made.id}`);
  await page.getByRole("button", { name: "Terminal" }).click();
  await page.getByRole("button", { name: "Run a script" }).click();
  await page.getByRole("menuitem", { name: "Say hi" }).click();
  await expect.poll(async () => {
    const list = await service.api<{ id: string; script: string | null }[]>("GET", `/api/threads/${made.id}/terminals`);
    const script = list.find((entry) => entry.script === "Say hi");
    if (!script) return "";
    return (await service.api<{ text: string }>("GET", `/api/threads/${made.id}/terminals/${script.id}/scrollback`)).text;
  }).toContain("from-the-script");

  await page.getByRole("button", { name: "Watch only" }).click();
  await expect(page.getByRole("button", { name: "Watch only" })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".xterm").first().click();
  await page.keyboard.type("echo not-sent\n");
  await page.waitForTimeout(300);
  const list = await service.api<{ id: string }[]>("GET", `/api/threads/${made.id}/terminals`);
  for (const entry of list) {
    const back = await service.api<{ text: string }>("GET", `/api/threads/${made.id}/terminals/${entry.id}/scrollback`);
    expect(back.text).not.toContain("not-sent");
  }
});

test("Rescan asks the hosts again, and shows the signed-in state", async ({ page }) => {
  await page.goto(`${service.page}#/settings/source-control`);
  // Every host's command line is asked, and a missing one can take a while to say so.
  await expect(page.locator(".setting-line").filter({ hasText: "GitHub" })).toContainText("Signed in", { timeout: 25_000 });
  const before = service.ghCalls().filter((call) => call[0] === "auth").length;
  await page.getByRole("button", { name: "Rescan" }).click();
  await expect.poll(() => service.ghCalls().filter((call) => call[0] === "auth").length).toBeGreaterThan(before);
});

test("a new worktree starts from the base the draft names", async ({ page }) => {
  execFileSync("git", ["branch", "release", "main"], { cwd: service.repo });
  execFileSync("git", ["switch", "-q", "release"], { cwd: service.repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "On release"], { cwd: service.repo });
  execFileSync("git", ["switch", "-q", "main"], { cwd: service.repo });
  await page.goto(`${service.page}#/new/${projectId}`);
  await page.getByRole("button", { name: "Current checkout" }).click();
  await page.getByRole("menuitem", { name: "New worktree" }).or(page.getByRole("menuitemradio", { name: "New worktree" })).first().click();
  await page.getByLabel("Worktree purpose").fill("from-release");
  await page.getByLabel("Base branch").fill("release");
  await send(page, "start here");
  await expect(page).toHaveURL(/#\/threads\//);
  const made = await service.api<{ cwd: string; worktree: { base: string } | null }>("GET", `/api/threads/${threadIdOf(page)}`);
  const tip = execFileSync("git", ["rev-parse", "release"], { cwd: service.repo, encoding: "utf8" }).trim();
  expect(made.worktree?.base).toBe(tip);
  await settled(service, threadIdOf(page));
});

test("the editor menu lists what's installed and opens the chosen one", async ({ page }) => {
  const log = join(service.binDir, "code-calls");
  writeFileSync(join(service.binDir, "code"), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
  const made = await thread("Editors");
  await page.goto(`${service.page}#/threads/${made.id}`);
  await page.getByRole("button", { name: "Choose editor" }).click();
  await page.getByRole("menuitem", { name: "VS Code" }).or(page.getByRole("menuitemradio", { name: "VS Code" })).first().click();
  await expect.poll(() => existsSync(log)).toBe(true);
  expect(readFileSync(log, "utf8")).toContain(".");
  await expect(page.getByRole("button", { name: "Open in VS Code" })).toBeVisible();
});

test("a file's menu opens it elsewhere, and dragging it mentions it", async ({ page }) => {
  const log = join(service.binDir, "code-calls");
  writeFileSync(join(service.binDir, "code"), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
  const made = await thread("File menu");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${made.id}`);
  await page.getByRole("button", { name: "Surfaces" }).click();
  await page.locator(".launcher").getByRole("button", { name: /Files/ }).click();
  const file = page.locator(".file-tree button").filter({ hasText: "README.md" }).first();
  await file.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Open in VS Code" }).click();
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "utf8") : "")).toContain("README.md");
  const data = await page.evaluateHandle(() => new DataTransfer());
  await file.dispatchEvent("dragstart", { dataTransfer: data });
  await page.locator(".composer-box").first().dispatchEvent("drop", { dataTransfer: data });
  await expect(page.getByRole("textbox", { name: /^Message/ }).first()).toHaveValue("@README.md ");
});

test("stopping a parent stops the child it delegated to", async ({ page }) => {
  const parent = await thread("Parent");
  await page.goto(`${service.page}#/threads/${parent.id}`);
  await send(page, "[hang]");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
  const child = await service.api<{ id: string }>("POST", `/api/threads/${parent.id}/delegate`, { prompt: "[hang]" });
  await expect.poll(async () => (await service.api<{ active_run: unknown }>("GET", `/api/threads/${child.id}`)).active_run).not.toBeNull();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => (await service.api<{ active_run: unknown }>("GET", `/api/threads/${parent.id}`)).active_run, { timeout: 15_000 }).toBeNull();
  await expect.poll(async () => (await service.api<{ active_run: unknown; last_run_state: unknown }>("GET", `/api/threads/${child.id}`)).active_run, { timeout: 15_000 }).toBeNull();
  await page.goto(`${service.page}#/threads/${child.id}`);
  await expect(page.getByText("Runs on its own")).toBeVisible();
});

test("a local ACP command becomes a provider", async ({ page }) => {
  await page.goto(`${service.page}#/settings/providers`);
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByRole("button", { name: "Local ACP command" }).click();
  await dialog.getByLabel("Executable").fill(FAKE);
  await dialog.getByRole("button", { name: "Add argument" }).click();
  await dialog.getByLabel("Argument 1").fill("acp");
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByLabel("Label").fill("House agent");
  await dialog.getByRole("button", { name: "Add instance" }).click();
  await expect(page.getByRole("button", { name: "Select House agent" })).toBeVisible({ timeout: 15_000 });
  await page.goto(`${service.page}#/settings/general`);
  await expect(page.getByRole("switch", { name: "Check providers for updates" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Prefer saved login" })).toHaveCount(0);
});

test("a new project starts with a README and a first commit", async ({ page }) => {
  await page.goto(service.page);
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("option", { name: /New project/ }).or(page.getByRole("button", { name: /New project/ })).first().click();
  await page.getByRole("textbox").last().fill("fresh-thing");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await service.api<{ name: string; path: string }[]>("GET", "/api/projects")).find((project) => project.name === "fresh-thing")?.path, { timeout: 15_000 })
    .toBeTruthy();
  const made = (await service.api<{ name: string; path: string }[]>("GET", "/api/projects")).find((project) => project.name === "fresh-thing");
  expect(existsSync(join(made?.path ?? "", "README.md"))).toBe(true);
  expect(execFileSync("git", ["log", "--oneline"], { cwd: made?.path, encoding: "utf8" }).trim()).not.toBe("");
});
