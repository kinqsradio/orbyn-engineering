import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startProject, type Service } from "./service";

async function fixture(log: string, asynchronous: boolean, exitCode = 0) {
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "");
  const { service, projectId } = await startProject({ fakeEngines: true, engineLaunchLog: log });
  await service.api("PUT", "/api/preferences", { values: { auto_thread_titles: false } });
  writeFileSync(join(service.repo, "setup-fixture.cjs"), `
const fs = require('node:fs');
fs.writeFileSync('setup-started', 'ready');
const timer = setInterval(() => {
  if (fs.existsSync('setup-release')) {
    clearInterval(timer);
    fs.writeFileSync('setup-finished', 'done');
    process.exit(${exitCode});
  }
}, 20);
setTimeout(() => process.exit(71), 30000).unref();
`);
  writeFileSync(join(service.repo, "orbyn.json"), JSON.stringify({ scripts: [{ name: "Setup", command: "node setup-fixture.cjs", runOnWorktreeCreate: true, async: asynchronous }] }));
  for (const args of [["add", "orbyn.json", "setup-fixture.cjs"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Setup fixture"]]) {
    execFileSync("git", ["-C", service.repo, ...args], { stdio: "ignore" });
  }
  const thread = await service.api<{ id: string; cwd: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Setup gate", worktree: "setup-gate" });
  await expect.poll(() => existsSync(join(thread.cwd, "setup-started"))).toBe(true);
  return { service, thread };
}

const turns = (log: string) => readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as { mode: string }).filter((row) => row.mode === "codex-turn").length;
const current = (service: Service, id: string) => service.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${id}`);

test("a synchronous setup holds the first engine turn until its real process exits", async ({ browserName: _browserName }, info) => {
  const log = info.outputPath("launch.ndjson");
  const { service, thread } = await fixture(log, false);
  try {
    await service.api("POST", `/api/threads/${thread.id}/runs`, { prompt: "setup-order-proof" });
    // The script is held by a file handshake. Allow the admitted task to run;
    // an unfenced baseline starts the protocol process during this window.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(turns(log)).toBe(0);
    expect((await current(service, thread.id)).active_run?.state).toBe("admitted");
    writeFileSync(join(thread.cwd, "setup-release"), "go");
    await expect.poll(() => turns(log)).toBe(1);
    await expect.poll(async () => (await current(service, thread.id)).active_run).toBeNull();
    expect(existsSync(join(thread.cwd, "setup-finished"))).toBe(true);
  } finally { await service.stop(); }
});

test("async setup releases the engine while the setup process is still held", async ({ browserName: _browserName }, info) => {
  const log = info.outputPath("launch.ndjson");
  const { service, thread } = await fixture(log, true);
  try {
    await service.api("POST", `/api/threads/${thread.id}/runs`, { prompt: "async-setup-proof" });
    await expect.poll(() => turns(log)).toBe(1);
    expect(existsSync(join(thread.cwd, "setup-finished"))).toBe(false);
    writeFileSync(join(thread.cwd, "setup-release"), "go");
    await expect.poll(() => existsSync(join(thread.cwd, "setup-finished"))).toBe(true);
  } finally { await service.stop(); }
});

test("failed synchronous setup never starts the engine", async ({ page }, info) => {
  const log = info.outputPath("launch.ndjson");
  const { service, thread } = await fixture(log, false, 7);
  try {
    await service.api("POST", `/api/threads/${thread.id}/runs`, { prompt: "failed-setup-proof" });
    writeFileSync(join(thread.cwd, "setup-release"), "go");
    await expect.poll(async () => (await current(service, thread.id)).active_run).toBeNull();
    expect(turns(log)).toBe(0);
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await expect(page.getByRole("log", { name: "Thread messages" }).getByRole("alert").getByText("Setup script Setup did not finish successfully.", { exact: true })).toBeVisible();
  } finally { await service.stop(); }
});

test("messages queued after failed setup stay held across new user turns and queue resume", async ({ browserName: _browserName }, info) => {
  const log = info.outputPath("launch.ndjson");
  const { service, thread } = await fixture(log, false, 7);
  try {
    await service.api("POST", `/api/threads/${thread.id}/runs`, { prompt: "first-setup-failure" });
    writeFileSync(join(thread.cwd, "setup-release"), "go");
    await expect.poll(async () => (await current(service, thread.id)).active_run).toBeNull();
    await service.api("POST", `/api/threads/${thread.id}/queue`, { prompt: "keep-this-queued" });
    const queue = () => service.api<{ prompt: string; held: boolean }[]>("GET", `/api/threads/${thread.id}/queue`);
    await expect.poll(queue).toEqual([expect.objectContaining({ prompt: "keep-this-queued", held: true })]);
    expect(turns(log)).toBe(0);
    await service.api("POST", `/api/threads/${thread.id}/runs`, { prompt: "explicit-new-turn" });
    await expect.poll(() => turns(log)).toBe(1);
    await expect.poll(async () => (await current(service, thread.id)).active_run).toBeNull();
    await service.api("POST", `/api/threads/${thread.id}/queue/resume`);
    await expect.poll(queue).toEqual([expect.objectContaining({ prompt: "keep-this-queued", held: true })]);
    expect(turns(log)).toBe(1);
  } finally { await service.stop(); }
});

test("cancelling a turn waiting on setup stops its setup process without starting the engine", async ({ browserName: _browserName }, info) => {
  const log = info.outputPath("launch.ndjson");
  const { service, thread } = await fixture(log, false);
  try {
    const run = await service.api<{ id: string }>("POST", `/api/threads/${thread.id}/runs`, { prompt: "cancel-setup-proof" });
    await service.api("POST", `/api/runs/${run.id}/cancel`);
    await expect.poll(async () => (await current(service, thread.id)).active_run).toBeNull();
    await expect.poll(async () => {
      const terminals = await service.api<{ script: string | null; alive: boolean }[]>("GET", `/api/threads/${thread.id}/terminals`);
      return terminals.find((terminal) => terminal.script === "Setup")?.alive;
    }).toBe(false);
    expect(turns(log)).toBe(0);
    expect(existsSync(join(thread.cwd, "setup-finished"))).toBe(false);
  } finally { await service.stop(); }
});

test("editing a saved setup command preserves its setup role and synchronous flag", async ({ page }, info) => {
  const { service, thread } = await fixture(info.outputPath("launch.ndjson"), false);
  try {
    const project = await service.api<{ project_id: string }>("GET", `/api/threads/${thread.id}`);
    await page.goto(`${service.page}#/settings/projects`);
    await page.getByRole("button", { name: "Settings for my-repo", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "my-repo settings", exact: true });
    const scripts = dialog.getByLabel("Project scripts", { exact: true });
    await scripts.fill("Setup: echo updated-setup");
    await scripts.blur();
    await expect.poll(async () => {
      const preferences = await service.api<{ key: string; value: unknown }[]>("GET", `/api/preferences?project_id=${project.project_id}`);
      return preferences.find((row) => row.key === "default_project_scripts")?.value;
    }).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Setup", command: "echo updated-setup", run_on_worktree_create: true, async: false })]));
  } finally { await service.stop(); }
});
