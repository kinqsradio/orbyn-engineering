import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

/** A fresh install against the real service, which the mock can't reach. */
const WEB = resolve(import.meta.dirname, "../..");
const BIN = process.env.ORBYN_BIN ?? resolve(WEB, "../target/debug/orbynd");
const PORT = 5276;
/** The desktop window less its native title bar. */
const WINDOW = { width: 1280, height: 792 };

let dir = "";
let token = "";
const children: ChildProcess[] = [];

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

test.beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error(`Build the service first: cargo build -p orbynd (${BIN})`);
  dir = mkdtempSync(join(tmpdir(), "orbyn-first-run-"));
  const service = spawn(BIN, ["serve", "--data-dir", join(dir, "data"), "--workspace-url", makeLibrary(dir)], {
    env: { ...process.env, ORBYN_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(service);
  const url = await new Promise<string>((done, fail) => {
    service.once("exit", (code) => fail(new Error(`orbynd exited with ${code}`)));
    createInterface({ input: service.stdout }).once("line", (line) => {
      const ready = JSON.parse(line) as { url: string; token: string };
      token = ready.token;
      done(ready.url);
    });
  });
  const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: WEB,
    env: { ...process.env, ORBYN_API: url },
    stdio: "ignore",
  });
  children.push(vite);
  await expect
    .poll(() => fetch(`http://localhost:${PORT}/`).then((response) => response.ok, () => false), {
      timeout: 15_000,
    })
    .toBe(true);
});

test.afterAll(() => {
  for (const child of children) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("first run shows a composed setup card and reaches the workspace", async ({ page }) => {
  await page.setViewportSize(WINDOW);
  await page.goto(`http://localhost:${PORT}/?token=${token}`);

  const heading = page.getByRole("heading", { name: "Set up your workspace" });
  await expect(heading).toBeVisible();

  const card = await page.locator(".standalone-card").boundingBox();
  if (!card) throw new Error("no setup card");
  expect(card.width).toBe(576);
  expect(Math.abs(card.x - (WINDOW.width - card.width) / 2)).toBeLessThanOrEqual(1);
  expect(card.y).toBeGreaterThanOrEqual(40);
  expect(WINDOW.height - (card.y + card.height)).toBeGreaterThanOrEqual(40);

  const managed = await page.getByText("Set up managed workspace").boundingBox();
  const adopt = await page.getByText("Adopt an existing library").boundingBox();
  if (!managed || !adopt) throw new Error("no choices");
  expect(adopt.y).toBeGreaterThan(managed.y + managed.height + 16);
  expect(managed.x).toBeGreaterThan(card.x + 16);

  await page.getByRole("radio", { name: /Adopt an existing library/ }).check();
  await expect(page.getByRole("button", { name: "Adopt this folder" })).toBeVisible();
  const opened = await page.locator(".standalone").evaluate((element) => ({
    top: element.querySelector(".standalone-card")?.getBoundingClientRect().top ?? 0,
    pageOverflow: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(opened.top).toBeGreaterThanOrEqual(40);
  expect(opened.pageOverflow).toBeLessThanOrEqual(0);

  await page.getByRole("radio", { name: /Set up managed workspace/ }).check();
  await page.getByRole("button", { name: "Set up workspace" }).click();
  await expect(page.getByRole("link", { name: "Review trust for Skills library" })).toBeVisible({
    timeout: 15_000,
  });
});
