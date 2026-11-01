import { expect, test } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const web = resolve(import.meta.dirname, "../..");

function firstLine(child: ChildProcess, accepts: (line: string) => boolean): Promise<string> {
  return new Promise((done, fail) => {
    if (!child.stdout) return fail(new Error("No startup stream"));
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error("Startup timed out")), 20_000);
    const exited = () => finish(new Error("Process exited before ready"));
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timer); lines.close();
      child.off("error", finish); child.off("exit", exited);
      if (error) fail(error); else done(line ?? "");
    };
    child.once("error", finish); child.once("exit", exited);
    lines.on("line", (line) => { if (accepts(line)) finish(undefined, line); });
  });
}

async function stop(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  if (child.stdin) child.stdin.end(); else child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([ended, new Promise<never>((_, fail) => {
      deadline = setTimeout(() => fail(new Error(`Process ${child.pid} did not stop`)), 10_000);
    })]);
  } finally { clearTimeout(timer); clearTimeout(deadline); }
}

test("selected routes follow lifecycle sections and limit recovery keeps snooze independent", async ({ page }, info) => {
  test.setTimeout(60_000);
  const profile = mkdtempSync(join(tmpdir(), "orbyn-thread-lifecycle-"));
  const children: ChildProcess[] = [];
  let failure: unknown;
  try {
    const binary = process.env.ORBYN_BIN ?? resolve(web, "../target/debug/orbynd");
    const fake = resolve(binary, "../orbyn-fake-engine");
    const library = join(profile, "library");
    mkdirSync(join(library, "skills/how"), { recursive: true });
    writeFileSync(join(library, "AGENTS.md"), "# Test library\n");
    writeFileSync(join(library, ".gitignore"), "repo/\n");
    writeFileSync(join(library, "skills/catalog.json"), '{"skills":[{"name":"how","category":"Engineering practice"}]}\n');
    writeFileSync(join(library, "skills/how/SKILL.md"), '---\nname: how\ndescription: "Trace behavior"\n---\n');
    const kept = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"];
    const env = { ...Object.fromEntries(kept.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
      HOME: profile, CFFIXED_USER_HOME: profile, USERPROFILE: profile, ORBYN_OFFLINE: "1",
      ORBYN_CLAUDE_BIN: join(profile, "no-claude"), ORBYN_CODEX_BIN: resolve(web, "e2e/real/scripted-engine.mjs"), ORBYN_E2E_FAKE: fake,
      CODEX_HOME: join(profile, "codex"), CLAUDE_CONFIG_DIR: join(profile, "claude"),
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: library, env, stdio: "ignore" });
    git("init", "-q"); git("add", "."); git("commit", "-qm", "Fixture");
    const service = spawn(binary,
      ["serve", "--parent-stdin", "--data-dir", join(profile, "data"), "--workspace-url", library],
      { env, stdio: ["pipe", "pipe", "inherit"] });
    children.push(service);
    const ready = JSON.parse(await firstLine(service, (line) => line.startsWith("{"))) as { url: string; token: string };
    async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetch(ready.url + path, { method, headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      return response.json() as Promise<T>;
    }
    await api("POST", "/api/workspace/setup", {});
    const project = await api<{ id: string }>("POST", "/api/projects/create", { name: "lifecycle-parity", readme: true });
    await api("POST", `/api/projects/${project.id}/trust`);
    await api("PUT", "/api/preferences", { values: { auto_thread_titles: false, auto_resume_limited_threads: false, snooze_limited_threads: false } });
    const makeThread = (title: string) => api<{ id: string }>("POST", "/api/threads", { project_id: project.id, engine: "codex", title, model: null, worktree: null, skill_profile: null });
    type Thread = { active_run: { state: string } | null; lifecycle: { settled_at: string | null; snoozed_until: string | null;
      limit?: { resume_at: string | null; resets_at: string | null } } };
    const thread = (id: string) => api<Thread>("GET", `/api/threads/${id}`);
    const socket = createServer();
    let port: number;
    try {
      socket.listen(0, "127.0.0.1"); await once(socket, "listening");
      const address = socket.address(); if (!address || typeof address === "string") throw new Error("No port");
      port = address.port;
    } finally { await new Promise<void>((done) => socket.close(() => done())); }
    const vite = spawn(process.execPath, [resolve(web, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"],
      { cwd: web, env: { ...env, ORBYN_API: ready.url, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "inherit"] });
    children.push(vite);
    await firstLine(vite, (line) => line.includes(`:${port}/`));
    await page.setViewportSize({ width: 1400, height: 900 });
    const running = await makeThread("Selected running thread");
    await api("POST", `/api/threads/${running.id}/runs`, { prompt: "[hang]" });
    await expect.poll(async () => (await thread(running.id)).active_run?.state).toBe("running");
    const row = (id: string) => page.locator(`li[data-thread-item="${id}"]`);
    await page.goto(`http://localhost:${port}/?token=${ready.token}#/threads/${running.id}`);
    await expect(row(running.id)).toHaveAttribute("data-section", "working");
    await expect(page).toHaveURL(new RegExp(running.id));
    await api("POST", `/api/threads/${running.id}/force-stop`, {});
    await expect.poll(async () => (await thread(running.id)).active_run).toBeNull();
    await expect(row(running.id)).toHaveAttribute("data-section", "active");
    await api("PATCH", `/api/threads/${running.id}`, { settled: true });
    await expect(row(running.id)).toHaveAttribute("data-section", "settled");
    await expect(page).toHaveURL(new RegExp(running.id));

    const limited = await makeThread("Limited thread");
    await api("POST", `/api/threads/${limited.id}/runs`, { prompt: "[scene:limit]" });
    await expect.poll(async () => (await thread(limited.id)).active_run).toBeNull();
    await page.goto(`http://localhost:${port}/?token=${ready.token}#/threads/${limited.id}`);
    const banner = page.getByRole("status", { name: "Limited" });
    await banner.getByRole("button", { name: "Resume at reset", exact: true }).click();
    await expect.poll(async () => (await thread(limited.id)).lifecycle.limit?.resume_at).toBe("2100-01-01T00:00:00Z");
    await expect(banner.getByRole("button", { name: "Cancel auto-resume", exact: true })).toBeVisible();
    await banner.getByRole("button", { name: "Snooze until reset", exact: true }).click();
    await expect(row(limited.id)).toHaveAttribute("data-section", "snoozed");
    await expect(banner.getByRole("button", { name: "Wake now", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("limit-recovery.png") });
    await banner.getByRole("button", { name: "Wake now", exact: true }).click();
    await expect.poll(async () => (await thread(limited.id)).lifecycle.snoozed_until).toBeNull();
    expect((await thread(limited.id)).active_run).toBeNull();
    expect((await thread(limited.id)).lifecycle.limit?.resume_at).toBe("2100-01-01T00:00:00Z");
    await banner.getByRole("button", { name: "Cancel auto-resume", exact: true }).click();
    await expect.poll(async () => (await thread(limited.id)).lifecycle.limit?.resume_at).toBeNull();
    await expect(banner.getByRole("button", { name: "Snooze until reset", exact: true })).toBeVisible();
    await page.goto(`http://localhost:${port}/?token=${ready.token}#/settings/chat`);
    await expect(page.getByRole("switch", { name: "Snooze until limits reset", exact: true })).toBeVisible();
    await page.getByRole("switch", { name: "Resume after usage limits", exact: true }).click();
    await expect.poll(async () => (await api<{ key: string; value: unknown }[]>("GET", "/api/preferences"))
      .find((entry) => entry.key === "auto_resume_limited_threads")?.value).toBe(true);
  } catch (error) { failure = error; }
  finally {
    const cleanup = await Promise.allSettled(children.map(stop));
    const errors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    try { rmSync(profile, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], "Fixture cleanup failed");
  }
  if (failure) throw failure;
});
