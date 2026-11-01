import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startProject, type Service } from "./service";

/** A background clone says how it stands and can be stopped or tried again. */

let service: Service;
let silent: Server;
const waiting: { destroy(): void }[] = [];

test.beforeAll(async () => {
  ({ service } = await startProject());
  // Takes the request and never answers, so the clone stays running.
  silent = createServer((request) => waiting.push(request.socket)).listen(0, "127.0.0.1");
  await new Promise((done) => silent.once("listening", done));
});
test.afterAll(async () => {
  for (const socket of waiting) socket.destroy();
  silent.close();
  await service.stop();
});

async function cloneFrom(page: Page, url: string) {
  await page.goto(`${service.page}#/new/scratch`);
  await page.getByRole("button", { name: "Add project" }).first().click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("button", { name: /Git URL/ }).click();
  await palette.getByLabel("Git clone URL").fill(url);
  await palette.getByLabel("Git clone URL").press("Enter");
  await expect(palette).toBeHidden();
}

test("a running clone can be cancelled", async ({ page }) => {
  const address = silent.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await cloneFrom(page, `http://127.0.0.1:${address.port}/stalled.git`);
  const jobs = page.getByRole("group", { name: "Project clones" });
  await expect(jobs).toContainText("Cloning");
  await jobs.getByRole("button", { name: "Cancel" }).click();
  await expect(jobs).toBeHidden();
});

test("a failed clone says why, and Retry finishes it once the remote is there", async ({ page }) => {
  const remote = join(service.folder, "later.git");
  await cloneFrom(page, remote);
  const jobs = page.getByRole("group", { name: "Project clones" });
  await expect(jobs).toContainText("Clone failed");

  const source = join(service.folder, "source");
  mkdirSync(source);
  writeFileSync(join(source, "README.md"), "# Later\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "First"], { cwd: source });
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);

  await jobs.getByRole("button", { name: "Retry" }).click();
  await expect(jobs).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => JSON.stringify(await service.api("GET", "/api/projects"))).toContain("later");
});
