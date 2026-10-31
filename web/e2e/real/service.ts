import { expect, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  // Linux runners restrict user namespaces, which the shell's sandbox needs; Playwright drops it the same way.
  const flags = process.platform === "linux" ? "--in-process-gpu --no-sandbox" : "--in-process-gpu";
  writeFileSync(wrapper, `#!/bin/sh\nexec "${shell}" ${flags} "$@"\n`, { mode: 0o755 });
  return wrapper;
}

export interface PullFixture {
  number: number;
  title: string;
  [field: string]: unknown;
}

const pullRow = ({ number, ...rest }: PullFixture) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: "OPEN",
  headRefName: "h",
  baseRefName: "main",
  author: { login: "a" },
  isDraft: false,
  updatedAt: "2026-10-01T00:00:00Z",
  labels: [],
  reviewDecision: "",
  statusCheckRollup: [],
  body: "",
  ...rest,
});

const STAND_IN_GH = resolve(WEB, "e2e/real/stand-in-gh.mjs");

/** Puts the stand-in first on PATH as `gh`, with its pull requests in a file. */
function standInGh(dir: string, pulls: PullFixture[]): { bin: string; state: string; log: string } {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const state = join(dir, "gh-state.json");
  const log = join(dir, "gh-calls.log");
  writeFileSync(log, "");
  writeFileSync(state, JSON.stringify({ pulls: pulls.map(pullRow), repos: [], next: 100, people: ["ada", "grace"], labels: ["bug", "docs"], template: pullRow({ number: 0, title: "" }) }));
  symlinkSync(STAND_IN_GH, join(bin, "gh"));
  return { bin, state, log };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function makeLibrary(root: string): string {
  const library = join(root, "library");
  mkdirSync(join(library, "skills/how"), { recursive: true });
  writeFileSync(join(library, "AGENTS.md"), "# Library\n");
  writeFileSync(join(library, "skills/catalog.json"), '{"skills":[{"name":"how","category":"Engineering practice"}]}\n');
  writeFileSync(join(library, "skills/how/SKILL.md"), '---\nname: how\ndescription: "Trace behavior"\n---\n\n# how\n');
  for (const host of [".claude", ".agents"]) {
    mkdirSync(join(library, host, "skills"), { recursive: true });
    symlinkSync("../../skills/how", join(library, host, "skills/how"));
  }
  writeFileSync(join(library, ".gitignore"), "repo/\n");
  git(library, "init", "-q", "-b", "main");
  git(library, "add", ".");
  git(library, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Library");
  return library;
}

export interface Service {
  /** The dev server in front of the real service, token included. */
  page: string;
  /** The service itself, for callers from outside the UI. */
  url: string;
  /** Where the service keeps its data. */
  dataDir: string;
  /** A folder on the service's PATH, for stand-in tools. Only with `forge`. */
  binDir: string;
  /** A plain folder outside any library, for the add-folder flow. */
  folder: string;
  /** A small Git repository outside the library. */
  repo: string;
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  stop(): void;
  /** What the stand-in `gh` was asked, oldest first. */
  ghCalls(): string[][];
  /** What the stand-in holds for one pull request now. */
  ghPull(number: number): Record<string, unknown>;
  /** The stand-in's bare remote, for specs that read what was pushed. */
  remote: string;
}

export interface ServiceOptions {
  fakeEngines?: boolean;
  scenes?: boolean;
  /** Runs `gh` through the stand-in, with these pull requests on the forge. */
  forge?: boolean | PullFixture[];
  registry?: string;
}

/** A real `orbynd` on a fresh data directory, with the dev UI proxied to it. */
export async function startService(
  port: number,
  options: ServiceOptions = {},
): Promise<Service> {
  if (!existsSync(BIN)) throw new Error(`Build the service first: cargo build -p orbynd (${BIN})`);
  const dir = mkdtempSync(join(tmpdir(), "orbyn-e2e-"));
  const fake = resolve(BIN, "../orbyn-fake-engine");
  const engines = options.scenes
    ? { ORBYN_CLAUDE_BIN: join(dir, "no-claude"), ORBYN_CODEX_BIN: SCRIPTED, ORBYN_E2E_FAKE: fake }
    : options.fakeEngines
      ? { ORBYN_CLAUDE_BIN: fake, ORBYN_CODEX_BIN: fake }
      : // Never an installed engine, so a run reads the same on every machine.
        { ORBYN_CLAUDE_BIN: join(dir, "no-claude"), ORBYN_CODEX_BIN: join(dir, "no-codex") };
  const forge = options.forge
    ? standInGh(dir, options.forge === true ? [{ number: 42, title: "Fix the login" }, { number: 77, title: "Tidy the docs" }] : options.forge)
    : null;
  const service = spawn(BIN, ["serve", "--data-dir", join(dir, "data"), "--workspace-url", makeLibrary(dir)], {
    // A home of its own, so no real engine history or login is read.
    env: { ...process.env, ...engines, ...(options.registry ? { ORBYN_ACP_REGISTRY_URL: options.registry } : {}), PATH: `${forge ? `${forge.bin}:` : ""}${process.env.PATH}`, ORBYN_GH_STATE: forge?.state ?? "", ORBYN_GH_LOG: forge?.log ?? "", ORBYN_BROWSER: previewBrowser(dir), ORBYN_BROWSER_HEADLESS: "1", ORBYN_OFFLINE: "1", HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    service.once("exit", (code) => fail(new Error(`orbynd exited with ${code}`)));
    createInterface({ input: service.stdout }).once("line", (line) => done(JSON.parse(line) as never));
  });
  // Node itself, so stopping it frees the port for a spec that restarts after a failure.
  const vite = spawn(process.execPath, [resolve(WEB, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"], {
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
  if (options.forge) {
    // A real remote on disk, named so the service takes it for GitHub.
    const remote = join(dir, "github.com/o/r.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "fetch", "-q", "origin");
  }
  return {
    url: ready.url,
    dataDir: join(dir, "data"),
    binDir: join(dir, "bin"),
    folder,
    repo,
    remote: join(dir, "github.com/o/r.git"),
    ghPull: (number) =>
      (JSON.parse(readFileSync(forge?.state ?? "", "utf8")) as { pulls: PullFixture[] }).pulls.find((pull) => pull.number === number) ?? {},
    ghCalls: () =>
      forge
        ? readFileSync(forge.log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
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
export async function startProject(port: number, options: ServiceOptions = {}) {
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
