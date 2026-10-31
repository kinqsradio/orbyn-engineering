import { expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const WEB = resolve(import.meta.dirname, "../..");
const BIN = process.env.ORBYN_BIN ?? resolve(WEB, "../target/debug/orbynd");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function makeLibrary(root: string): string {
  const library = join(root, "library");
  mkdirSync(join(library, "skills"), { recursive: true });
  writeFileSync(join(library, "AGENTS.md"), "# Library\n");
  writeFileSync(join(library, "skills/catalog.json"), "[]\n");
  writeFileSync(join(library, ".gitignore"), "repo/\n");
  git(library, "init", "-q", "-b", "main");
  git(library, "add", ".");
  git(library, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Library");
  return library;
}

export interface Service {
  /** The dev server in front of the real service, token included. */
  page: string;
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  stop(): void;
}

/** A real `orbynd` on a fresh data directory, with the dev UI proxied to it. */
export async function startService(port: number): Promise<Service> {
  if (!existsSync(BIN)) throw new Error(`Build the service first: cargo build -p orbynd (${BIN})`);
  const dir = mkdtempSync(join(tmpdir(), "orbyn-e2e-"));
  const service = spawn(BIN, ["serve", "--data-dir", join(dir, "data"), "--workspace-url", makeLibrary(dir)], {
    // A home of its own, so no real engine history or login is read.
    env: { ...process.env, ORBYN_OFFLINE: "1", HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") },
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
  return {
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
