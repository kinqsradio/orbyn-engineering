import { expect, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const WEB = resolve(import.meta.dirname, "../..");
const BIN = process.env.ORBYN_BIN ?? resolve(WEB, "../target/debug/orbynd");
const SCRIPTED = resolve(WEB, "e2e/real/scripted-engine.mjs");

/** The shell from `npm run test:e2e:install`, so the service's previews never open an installed browser. */
function headlessShell(): string {
  const root = resolve(WEB, "node_modules/playwright-core/.local-browsers");
  const dir = existsSync(root) ? readdirSync(root).find((name) => name.startsWith("chromium_headless_shell-")) : undefined;
  const build = dir && join(root, dir);
  const inner = build && readdirSync(build).find((name) => name.startsWith("chrome-headless-shell"));
  const binary = inner && build && join(build, inner, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
  if (!binary || !existsSync(binary)) throw new Error("Install the headless shell first: npm run test:e2e:install");
  return binary;
}

/** The shell needs its GPU work in-process here, and the service passes no such flag itself. */
function previewBrowser(dir: string): string {
  const shell = headlessShell();
  if (process.platform === "win32") return shell;
  const wrapper = join(dir, "preview-browser");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${shell}" --in-process-gpu "$@"\n`, { mode: 0o755 });
  return wrapper;
}

/** Answers `gh pr list` like the real CLI, so forge routes run with no network. */
function standInGh(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const pull = (number: number, title: string) =>
    JSON.stringify({ number, title, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", headRefName: "h", baseRefName: "main", author: { login: "a" }, isDraft: false, updatedAt: "2026-10-01T00:00:00Z", labels: [], reviewDecision: "", statusCheckRollup: [] });
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n  "pr list") echo '[${pull(42, "Fix the login")},${pull(77, "Tidy the docs")}]' ;;\n  "auth status") echo "Logged in to github.com" >&2 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return bin;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function makeLibrary(root: string): string {
  const library = join(root, "library");
  mkdirSync(join(library, "skills"), { recursive: true });
  writeFileSync(join(library, "AGENTS.md"), "# Library\n");
  writeFileSync(join(library, "skills/catalog.json"), '{"skills":[]}\n');
  writeFileSync(join(library, ".gitignore"), "repo/\n");
  git(library, "init", "-q", "-b", "main");
  git(library, "add", ".");
  git(library, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Library");
  return library;
}

export interface Service {
  /** The dev server in front of the real service, token included. */
  page: string;
  /** A plain folder outside any library, for the add-folder flow. */
  folder: string;
  /** A small Git repository outside the library. */
  repo: string;
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  stop(): void;
}

/** A real `orbynd` on a fresh data directory, with the dev UI proxied to it. */
export async function startService(
  port: number,
  options: { fakeEngines?: boolean; scenes?: boolean; forge?: boolean; registry?: string } = {},
): Promise<Service> {
  if (!existsSync(BIN)) throw new Error(`Build the service first: cargo build -p orbynd (${BIN})`);
  const dir = mkdtempSync(join(tmpdir(), "orbyn-e2e-"));
  const fake = resolve(BIN, "../orbyn-fake-engine");
  const engines = options.scenes
    ? { ORBYN_CLAUDE_BIN: join(dir, "no-claude"), ORBYN_CODEX_BIN: SCRIPTED, ORBYN_E2E_FAKE: fake }
    : options.fakeEngines
      ? { ORBYN_CLAUDE_BIN: fake, ORBYN_CODEX_BIN: fake }
      : {};
  const forgePath = options.forge ? `${standInGh(dir)}:` : "";
  const service = spawn(BIN, ["serve", "--data-dir", join(dir, "data"), "--workspace-url", makeLibrary(dir)], {
    // A home of its own, so no real engine history or login is read.
    env: { ...process.env, ...engines, ...(options.registry ? { ORBYN_ACP_REGISTRY_URL: options.registry } : {}), PATH: `${forgePath}${process.env.PATH}`, ORBYN_BROWSER: previewBrowser(dir), ORBYN_BROWSER_HEADLESS: "1", ORBYN_OFFLINE: "1", HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    service.once("exit", (code) => fail(new Error(`orbynd exited with ${code}`)));
    createInterface({ input: service.stdout }).once("line", (line) => done(JSON.parse(line) as never));
  });
  const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
    cwd: WEB,
    env: { ...process.env, ORBYN_API: ready.url },
    stdio: "ignore",
  });
  await expect
    .poll(() => fetch(`http://localhost:${port}/`).then((response) => response.ok, () => false), {
      timeout: 15_000,
    })
    .toBe(true);
  const folder = join(dir, "my-folder");
  mkdirSync(folder);
  const repo = join(dir, "my-repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# Repo\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "First");
  if (options.forge) git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  return {
    folder,
    repo,
    page: `http://localhost:${port}/?token=${ready.token}`,
    async api<T>(method: string, path: string, body?: unknown) {
      const response = await fetch(`${ready.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${ready.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
    stop() {
      service.kill();
      vite.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A signed-in workspace on one trusted repository, for specs that start from a thread. */
export async function startProject(port: number, options: { fakeEngines?: boolean; scenes?: boolean; forge?: boolean; registry?: string } = {}) {
  const service = await startService(port, options);
  await service.api("POST", "/api/workspace/setup", {});
  const project = await service.api<{ id: string }>("POST", "/api/projects/add", { path: service.repo });
  await service.api("POST", `/api/projects/${project.id}/trust`);
  const engines = await service.api<{ id: string; name: string }[]>("GET", "/api/engines");
  return { service, projectId: project.id, engines };
}

/** Sends from the composer and waits for the prompt to be taken. */
export async function send(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill(text);
  await box.press("Enter");
}

export const threadIdOf = (page: Page) => decodeURIComponent(page.url().split("/threads/")[1] ?? "");

/** Waits until the thread has no run going. */
export async function settled(service: Service, id: string) {
  await expect
    .poll(async () => (await service.api<{ active_run: unknown }>("GET", `/api/threads/${id}`)).active_run, { timeout: 15_000 })
    .toBeNull();
}
