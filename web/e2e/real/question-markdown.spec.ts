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

test("custom question text replaces a selected option in the real answer flow", async ({ page }, info) => {
  test.setTimeout(60_000);
  const profile = mkdtempSync(join(tmpdir(), "orbyn-question-markdown-"));
  const children: ChildProcess[] = [];
  let failure: unknown;
  try {
    const binary = process.env.ORBYN_BIN ?? resolve(web, "../target/debug/orbynd");
    const fake = resolve(binary, "../orbyn-fake-engine");
    const wrapper = join(profile, "question-engine.mjs");
    const prose = "### Review approach\n\nUse **small** steps and `checks`.\n\n- First\n- Next\n\n```mermaid\ngraph LR; A-->B;\n```\n\n<script>unsafe()</script>";
    // Only question prose/options are enriched; the existing protocol double handles all requests.
    writeFileSync(wrapper, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const child = spawn(process.env.ORBYN_E2E_FAKE, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(line + "\\n"); return; }
  if (message.method === "item/tool/requestUserInput") {
    Object.assign(message.params.questions[0], { header: "Review", question: ${JSON.stringify(prose)}, isSecret: false, isOther: true,
      options: [{ label: "Small batch", description: "" }, { label: "All at once", description: "" }] });
    message.params.questions.push({ id: "q2", header: "Follow-up", question: "What should we **keep**?", isSecret: false, isOther: true, options: null });
  }
  process.stdout.write(JSON.stringify(message) + "\\n");
});
child.on("exit", (code) => process.exit(code ?? 1));
`, { mode: 0o755 });
    const library = join(profile, "library");
    mkdirSync(join(library, "skills/how"), { recursive: true });
    writeFileSync(join(library, "AGENTS.md"), "# Test library\n");
    writeFileSync(join(library, ".gitignore"), "repo/\n");
    writeFileSync(join(library, "skills/catalog.json"), '{"skills":[{"name":"how","category":"Engineering practice"}]}\n');
    writeFileSync(join(library, "skills/how/SKILL.md"), '---\nname: how\ndescription: "Trace behavior"\n---\n');
    const kept = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"];
    const env = { ...Object.fromEntries(kept.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
      HOME: profile, CFFIXED_USER_HOME: profile, USERPROFILE: profile, ORBYN_OFFLINE: "1",
      ORBYN_CLAUDE_BIN: join(profile, "no-claude"), ORBYN_CODEX_BIN: wrapper, ORBYN_E2E_FAKE: fake,
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
    const project = await api<{ id: string }>("POST", "/api/projects/create", { name: "question-markdown", readme: true });
    await api("POST", `/api/projects/${project.id}/trust`);
    await api("PUT", "/api/preferences", { values: { auto_thread_titles: false } });
    const thread = await api<{ id: string }>("POST", "/api/threads", { project_id: project.id, engine: "codex", title: "Question", model: null, worktree: null, skill_profile: null });
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
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${port}/?token=${ready.token}#/threads/${thread.id}`);
    await api("POST", `/api/threads/${thread.id}/runs`, { prompt: "[question] Show the review question" });
    const panel = page.getByRole("region", { name: "Question from the agent" });
    await expect(panel.getByRole("heading", { name: "Review approach" })).toBeVisible();
    await expect(panel.locator(".md strong").filter({ hasText: "small" })).toHaveCount(1);
    await expect(panel.getByRole("list")).toHaveCount(1);
    await expect(panel.getByRole("img", { name: "Diagram", exact: true })).toBeVisible();
    await expect(panel.locator("script")).toHaveCount(0);
    await expect(panel).toContainText("<script>unsafe()</script>");
    await page.screenshot({ path: info.outputPath("question-markdown.png") });
    await panel.getByRole("button", { name: "Small batch", exact: true }).click();
    const custom = panel.getByRole("group", { name: "Review", exact: true }).getByRole("textbox");
    await custom.fill("Custom rollout"); await expect(custom).toBeFocused();
    await panel.getByRole("group", { name: "Follow-up", exact: true }).getByRole("textbox").fill("Keep a rollback");
    const submitted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/answer"));
    await panel.getByRole("button", { name: "Submit answers", exact: true }).click();
    expect((await submitted).status()).toBe(200);
    await expect(panel).toBeHidden();
    type Question = { state: string; answers: Record<string, string[]> };
    const questions = await api<Question[]>("GET", `/api/questions?thread_id=${thread.id}`);
    expect(questions[0]?.state).toBe("answered");
    expect(questions[0]?.answers.q1).toEqual(["Custom rollout"]);
    expect(questions[0]?.answers.q2).toEqual(["Keep a rollback"]);
    await expect.poll(async () => (await api<{ active_run: unknown }>("GET", `/api/threads/${thread.id}`)).active_run).toBeNull();
  } catch (error) { failure = error; }
  finally {
    const cleanup = await Promise.allSettled(children.map(stop));
    const errors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    try { rmSync(profile, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], "Fixture cleanup failed");
  }
  if (failure) throw failure;
});
