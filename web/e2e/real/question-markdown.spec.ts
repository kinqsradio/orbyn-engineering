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
    const fake = resolve(binary, `../orbyn-fake-engine${process.platform === "win32" ? ".exe" : ""}`);
    const wrapper = join(profile, "question-engine.mjs");
    const launcher = process.platform === "win32" ? join(profile, "question-engine.cmd") : wrapper;
    // The service follows this npm-style shim to Node on Windows; it never invokes cmd.exe.
    if (launcher !== wrapper) writeFileSync(launcher, '@echo off\r\nnode "%~dp0\\question-engine.mjs" %*\r\n');
    const library = join(profile, "library");
    const questionFile = join(profile, "question.md");
    // Only question prose/options are enriched; the existing protocol double handles all requests.
    writeFileSync(wrapper, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const child = spawn(process.env.ORBYN_E2E_FAKE, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(line + "\\n"); return; }
  if (message.method === "item/tool/requestUserInput") {
    Object.assign(message.params.questions[0], { header: "Review", question: readFileSync(${JSON.stringify(questionFile)}, "utf8"), isSecret: false, isOther: true,
      options: [{ label: "Small batch", description: "" }, { label: "All at once", description: "" }] });
    message.params.questions.push({ id: "q2", header: "Follow-up", question: "What should we **keep**?", isSecret: false, isOther: true, options: null });
  }
  process.stdout.write(JSON.stringify(message) + "\\n");
});
child.on("exit", (code) => process.exit(code ?? 1));
`, { mode: 0o755 });
    mkdirSync(join(library, "skills/how"), { recursive: true });
    writeFileSync(join(library, "AGENTS.md"), "# Test library\n");
    writeFileSync(join(library, ".gitignore"), "repo/\n");
    writeFileSync(join(library, "skills/catalog.json"), '{"skills":[{"name":"how","category":"Engineering practice"}]}\n');
    writeFileSync(join(library, "skills/how/SKILL.md"), '---\nname: how\ndescription: "Trace behavior"\n---\n');
    const kept = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"];
    const env = { ...Object.fromEntries(kept.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
      HOME: profile, CFFIXED_USER_HOME: profile, USERPROFILE: profile, ORBYN_OFFLINE: "1",
      ORBYN_CLAUDE_BIN: join(profile, "no-claude"), ORBYN_CODEX_BIN: launcher, ORBYN_E2E_FAKE: fake, ORBYN_KNOWN_ENGINE_IDS: "[]",
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
    const project = await api<{ id: string; path: string }>("POST", "/api/projects/create", { name: "question-markdown", readme: true });
    const checkout = project.path;
    const outside = resolve(checkout, "../..", "outside.png");
    const absoluteImage = encodeURI(join(checkout, "docs", "absolute shot.png").replace(/\\/g, "/"));
    const outsideImage = encodeURI(outside.replace(/\\/g, "/"));
    const prose = "### Review approach\n\nUse **small** steps and `checks`.\n\n- First\n- Next\n\n```mermaid\ngraph LR; A-->B;\n```\n\n![Remote diagram](https://remote.example/diagram.svg)\n\n"
      + `![Relative](docs/relative.png) ![Encoded](docs/my%20shot.png) ![Absolute](${absoluteImage})\n\n`
      + `![Missing](docs/missing.png) ![Traversal](..%2F..%2Foutside.png) ![Outside](${outsideImage})\n\n`
      + "<script>unsafe()</script>\n\n<svg onload=unsafe()></svg>";
    writeFileSync(questionFile, prose);
    mkdirSync(join(checkout, "docs"));
    // Synthetic PNGs only; the outside file proves refusal rather than a missing-file result.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
    for (const name of ["relative.png", "my shot.png", "absolute shot.png"]) writeFileSync(join(checkout, "docs", name), png);
    writeFileSync(outside, png);
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
    const remoteRequests: string[] = [];
    const remoteMediaRequests: string[] = [];
    const rawResponses = new Map<string, number>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/media/image") remoteMediaRequests.push(url.pathname);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === `/api/threads/${thread.id}/files/raw`) {
        rawResponses.set(url.searchParams.get("path") ?? "", response.status());
      }
    });
    await page.route("https://remote.example/**", (route) => { remoteRequests.push(route.request().url()); return route.abort(); });
    await page.goto(`http://localhost:${port}/?token=${ready.token}#/threads/${thread.id}`);
    await api("POST", `/api/threads/${thread.id}/runs`, { prompt: "[question] Show the review question" });
    const panel = page.getByRole("region", { name: "Question from the agent" });
    await expect(panel.getByRole("heading", { name: "Review approach" })).toBeVisible();
    await expect(panel.locator(".md strong").filter({ hasText: "small" })).toHaveCount(1);
    await expect(panel.getByRole("list")).toHaveCount(1);
    await expect(panel.getByRole("img", { name: "Diagram", exact: true })).toBeVisible();
    await expect(panel.locator("script")).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Remote diagram" })).toHaveAttribute("href", "https://remote.example/diagram.svg");
    for (const name of ["Relative", "Encoded", "Absolute"]) {
      const image = panel.getByRole("img", { name, exact: true });
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    }
    await expect(panel.getByText("Image unavailable · Missing", { exact: true })).toBeVisible();
    await expect(panel.getByText("Image unavailable · Traversal", { exact: true })).toBeVisible();
    expect(rawResponses.get("docs/relative.png")).toBe(200);
    expect(rawResponses.get("docs/my shot.png")).toBe(200);
    expect(rawResponses.get("docs/absolute shot.png")).toBe(200);
    expect(rawResponses.get("docs/missing.png")).toBe(404);
    expect(rawResponses.get("../../outside.png")).toBe(400);
    expect([...rawResponses.keys()].sort()).toEqual([
      "docs/relative.png", "docs/my shot.png", "docs/absolute shot.png", "docs/missing.png", "../../outside.png",
    ].sort());
    await expect(panel).toContainText(`![Outside](${outsideImage})`);
    await expect(panel.locator("img")).toHaveCount(3);
    await expect(panel.locator("video, iframe, svg[onload]")).toHaveCount(0);
    expect(remoteRequests).toEqual([]);
    expect(remoteMediaRequests).toEqual([]);
    await expect(panel).toContainText("<script>unsafe()</script>");
    await expect(panel).toContainText("<svg onload=unsafe()></svg>");
    await panel.getByRole("button", { name: "Expand Encoded", exact: true }).click();
    const imageDialog = page.getByRole("dialog", { name: "Encoded", exact: true });
    await expect(imageDialog.getByRole("img", { name: "Encoded", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(imageDialog).toBeHidden();
    await expect(panel.getByRole("button", { name: "Expand Encoded", exact: true })).toBeFocused();
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
