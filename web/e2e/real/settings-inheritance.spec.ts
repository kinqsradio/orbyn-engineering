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

test("project settings explain inheritance and reset only their own override", async ({ page }, info) => {
  test.setTimeout(60_000);
  const profile = mkdtempSync(join(tmpdir(), "orbyn-inheritance-"));
  const children: ChildProcess[] = [];
  let failure: unknown;
  try {
    const library = join(profile, "library");
    mkdirSync(join(library, "skills/how"), { recursive: true });
    writeFileSync(join(library, "AGENTS.md"), "# Test library\n");
    writeFileSync(join(library, ".gitignore"), "repo/\n");
    writeFileSync(join(library, "skills/catalog.json"), '{"skills":[{"name":"how","category":"Engineering practice"}]}\n');
    writeFileSync(join(library, "skills/how/SKILL.md"), '---\nname: how\ndescription: "Trace behavior"\n---\n');
    const kept = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"];
    const env = { ...Object.fromEntries(kept.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
      HOME: profile, CFFIXED_USER_HOME: profile, USERPROFILE: profile, ORBYN_OFFLINE: "1",
      ORBYN_CLAUDE_BIN: join(profile, "no-claude"), ORBYN_CODEX_BIN: process.env.ORBYN_FAKE_ENGINE ?? resolve(web, "../target/debug/orbyn-fake-engine"),
      CODEX_HOME: join(profile, "codex"), CLAUDE_CONFIG_DIR: join(profile, "claude"),
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: library, env, stdio: "ignore" });
    git("init", "-q"); git("add", "."); git("commit", "-qm", "Fixture");
    const service = spawn(process.env.ORBYN_BIN ?? resolve(web, "../target/debug/orbynd"),
      ["serve", "--parent-stdin", "--data-dir", join(profile, "data"), "--workspace-url", library],
      { env, stdio: ["pipe", "pipe", "inherit"] });
    children.push(service);
    const ready = JSON.parse(await firstLine(service, (line) => line.startsWith("{"))) as { url: string; token: string };
    async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetch(ready.url + path, { method, headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
      return response.json() as Promise<T>;
    }
    await api("POST", "/api/workspace/setup", {});
    const a = await api<{ id: string; path: string }>("POST", "/api/projects/create", { name: "inheritance-a", readme: true });
    const b = await api<{ id: string }>("POST", "/api/projects/create", { name: "inheritance-b", readme: true });
    await api("POST", `/api/projects/${a.id}/trust`, {});
    await api("PUT", "/api/preferences", { values: { auto_thread_titles: false } });
    writeFileSync(join(a.path, "orbyn.json"), '{"defaultThreadEnvMode":"worktree","worktreeSubmodules":"none"}\n');
    await api("PUT", "/api/preferences", { values: { auto_pull: true, default_model: "same-model" } });
    await api("PUT", `/api/projects/${a.id}/preferences`, { values: { auto_pull: false, default_model: "same-model" } });
    await api("PUT", `/api/projects/${b.id}/preferences`, { values: { auto_pull: false } });
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
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(`http://localhost:${port}/?token=${ready.token}#/settings/projects`);
    await page.getByRole("button", { name: "Settings for inheritance-a", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "inheritance-a settings", exact: true });
    const submodules = dialog.locator(".setting-line").filter({ has: page.getByText("Submodules", { exact: true }) });
    await expect(submodules.getByRole("combobox")).toHaveValue("none");
    await submodules.getByRole("combobox").selectOption("top-level");
    await expect(submodules.getByRole("button", { name: "Reset Submodules to default", exact: true })).toBeEnabled();
    expect((await api<Pref[]>("GET", `/api/preferences?project_id=${a.id}`)).find((entry) => entry.key === "worktree_submodules")?.value).toBe("top-level");
    await submodules.getByRole("button", { name: "Reset Submodules to default", exact: true }).click();
    await expect(submodules.getByRole("combobox")).toHaveValue("none");
    const checkoutRow = dialog.locator(".setting-line").filter({ has: page.getByText("Default checkout", { exact: true }) });
    await expect(checkoutRow.getByRole("combobox")).toHaveValue("worktree");
    await checkoutRow.getByRole("button", { name: /Inherited from orbyn.json.*Show where/ }).click();
    const checkoutLayers = dialog.getByRole("dialog", { name: "Default checkout", exact: true });
    await expect(checkoutLayers.getByText("orbyn.json", { exact: true }).locator("..")).toHaveText(/New worktree/);
    await expect(checkoutLayers.getByText("Default", { exact: true }).locator("..")).toHaveText(/Current checkout/);
    await page.keyboard.press("Escape");
    await checkoutRow.getByRole("combobox").selectOption("local");
    await expect(checkoutRow.getByRole("button", { name: "Reset Default checkout to default", exact: true })).toBeEnabled();
    await checkoutRow.getByRole("button", { name: "Reset Default checkout to default", exact: true }).click();
    await expect(checkoutRow.getByRole("combobox")).toHaveValue("worktree");
    const title = "Pull the default branch automatically";
    const row = dialog.locator(".setting-line").filter({ has: page.getByText(title, { exact: true }) });
    const source = row.getByRole("button", { name: /Show where this value comes from/ });
    await expect(dialog.getByRole("button", { name: "Reset Default model to default", exact: true })).toBeEnabled();
    await source.focus(); await page.keyboard.press("Enter");
    const popup = dialog.getByRole("dialog", { name: title, exact: true });
    await expect(popup).toBeVisible();
    await expect(popup.getByText("Project", { exact: true }).locator("..")).toHaveText(/Off/);
    await expect(popup.getByText("Environment", { exact: true }).locator("..")).toHaveText(/On/);
    await expect(popup.getByText("Default", { exact: true }).locator("..")).toHaveText(/Off/);
    await expect.poll(() => popup.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return hit !== null && element.contains(hit);
    })).toBe(true);
    await page.screenshot({ path: info.outputPath("inheritance-desktop.png") });
    await page.setViewportSize({ width: 720, height: 480 });
    // setViewportSize can resolve before the browser dispatches resize and places the popup.
    await expect.poll(async () => {
      const bounds = await popup.boundingBox();
      return bounds === null ? Infinity : bounds.x + bounds.width;
    }).toBeLessThanOrEqual(720);
    const bounds = await popup.boundingBox(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(480);
    await page.screenshot({ path: info.outputPath("inheritance-narrow.png") });
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden(); await expect(dialog).toBeVisible(); await expect(source).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popup).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(popup).toBeHidden();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const reset = row.getByRole("button", { name: `Reset ${title} to default`, exact: true });
    const projectPreferences = `**/api/projects/${a.id}/preferences`;
    // Only this failure response is injected; persistence checks use the real service.
    await page.route(projectPreferences, (route) => route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "unavailable", message: "Reset unavailable. Try again." }) }));
    await reset.click();
    await expect(dialog.getByRole("alert")).toHaveText(/Reset unavailable/);
    await expect(row.getByRole("switch")).not.toBeChecked();
    await expect(reset).toBeEnabled();
    await page.unroute(projectPreferences);
    await reset.click();
    await expect(row.getByRole("switch")).toBeChecked();
    type Pref = { key: string; value: unknown; source: string };
    const value = (rows: Pref[], key: string) => rows.find((entry) => entry.key === key);
    expect(value(await api<Pref[]>("GET", `/api/preferences?project_id=${a.id}`), "auto_pull")?.source).toBe("global");
    expect(value(await api<Pref[]>("GET", `/api/preferences?project_id=${b.id}`), "auto_pull")?.value).toBe(false);
    expect(value(await api<Pref[]>("GET", "/api/preferences"), "auto_pull")?.value).toBe(true);
    expect(value(await api<Pref[]>("GET", `/api/preferences?project_id=${a.id}`), "default_model")?.source).toBe("project");
    await api("PUT", "/api/preferences", { values: { auto_pull: false } });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Settings for inheritance-a", exact: true }).click();
    await expect(row.getByRole("switch")).not.toBeChecked();
    await expect(row.getByRole("button", { name: `Reset ${title} to default`, exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.goto(`http://localhost:${port}/#/new/${a.id}`);
    await expect(page.getByRole("button", { name: "New worktree", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New worktree", exact: true }).click();
    await page.getByRole("menuitem", { name: "Current checkout", exact: true }).click();
    await expect(page.getByRole("button", { name: "Current checkout", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Worktree purpose", exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use current checkout");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/#\/threads\//);
    const currentId = new URL(page.url()).hash.split("/").at(-1)!;
    const currentThread = await api<{ worktree: null; cwd: string }>("GET", `/api/threads/${currentId}`);
    expect(currentThread.worktree).toBeNull(); expect(currentThread.cwd).toBe(a.path);
    await page.goto(`http://localhost:${port}/#/new/${a.id}`);
    await expect(page.getByRole("button", { name: "New worktree", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use file checkout default");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/#\/threads\//);
    const isolatedId = new URL(page.url()).hash.split("/").at(-1)!;
    const isolatedThread = await api<{ worktree: { path: string }; cwd: string }>("GET", `/api/threads/${isolatedId}`);
    expect(isolatedThread.worktree.path).not.toBe(a.path);
    expect(isolatedThread.cwd).toBe(isolatedThread.worktree.path);

  } catch (error) { failure = error; }
  finally {
    const cleanup = await Promise.allSettled(children.map(stop));
    const errors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    try { rmSync(profile, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], "Fixture cleanup failed");
  }
  if (failure) throw failure;
});
