import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { send, settled, startProject } from "./service";

async function fixture() {
  const { service } = await startProject({ scenes: true });
  const child = join(service.repo, "packages/web");
  mkdirSync(join(child, "packages/web"), { recursive: true });
  mkdirSync(join(service.repo, "packages/api"), { recursive: true });
  writeFileSync(join(child, "kept.txt"), "child-base\nsecond-line\n");
  writeFileSync(join(child, "other.txt"), "newest-file-only\n");
  writeFileSync(join(child, "packages/web/kept.txt"), "literal-duplicate-must-not-open\n");
  writeFileSync(join(child, "links.md"), "[move link](kept.txt)\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: service.repo, stdio: "ignore" });
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Subfolder fixture");
  writeFileSync(join(child, "kept.txt"), "child-diff-new\nsecond-line\n");
  writeFileSync(join(service.repo, "README.md"), "outside-diff-stays-viewable\n");
  const project = await service.api<{ id: string }>("POST", "/api/projects/add", { path: child });
  await service.api("POST", `/api/projects/${project.id}/trust`);
  const thread = await service.api<{ id: string; cwd: string }>("POST", "/api/threads", { project_id: project.id, engine: "codex", title: "Subfolder browser" });
  return { service, child, thread };
}

async function conversation(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${f.service.page}#/threads/${f.thread.id}`);
  await send(page, "[scene:subfolder-links]");
  await settled(f.service, f.thread.id);
  await expect(page.getByRole("button", { name: "repository path", exact: true })).toBeVisible();
}

test("subfolder file links stay local while repository-wide patches remain visible", async ({ page }) => {
  const f = await fixture();
  try {
    const reads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/files/content")) reads.push(url.searchParams.get("path") ?? "");
    });
    await conversation(page, f);
    await page.getByRole("button", { name: "repository path", exact: true }).click();
    await expect(page.locator(".file-source")).toContainText("child-diff-new");
    await expect(page.locator(".file-source")).not.toContainText("literal-duplicate-must-not-open");
    expect(reads).toContain("kept.txt");
    expect(reads).not.toContain("packages/web/kept.txt");
    await page.getByRole("button", { name: "sibling path", exact: true }).click();
    await expect(page.getByText("That path is outside this checkout.", { exact: true })).toBeVisible();
    expect(reads.some((path) => path.includes("README.md"))).toBe(false);
    await page.getByRole("button", { name: "View diff", exact: true }).click();
    const inside = page.locator('[data-diff-file="packages/web/kept.txt"]');
    const outside = page.locator('[data-diff-file="README.md"]');
    await expect(inside).toBeVisible();
    await expect(outside).toBeVisible();
    if (await outside.getByRole("button", { expanded: false }).count()) await outside.getByRole("button", { expanded: false }).click();
    await expect(outside).toContainText("outside-diff-stays-viewable");
    await page.getByRole("button", { name: "1 file changed", exact: true }).click();
    const resolution = page.waitForResponse((response) => response.url().endsWith("/paths/resolve") && response.request().postDataJSON()?.basis === "repository");
    await page.locator(".changed-files button").filter({ hasText: "packages/web/kept.txt" }).click();
    expect((await resolution).status()).toBe(200);
    await expect(inside).toBeVisible();
  } finally { await f.service.stop(); }
});

test("new file clicks and route changes cancel older subfolder lookups", async ({ page }) => {
  const f = await fixture();
  const releases: (() => void)[] = [];
  let pending = 0;
  try {
    await conversation(page, f);
    await page.route(`**/api/threads/${f.thread.id}/paths/resolve`, async (route) => {
      pending += 1;
      try {
        if (route.request().postDataJSON()?.path === "packages/web/kept.txt") await new Promise<void>((resolve) => releases.push(resolve));
        if (!route.request().failure()) await route.continue();
      } finally { pending -= 1; }
    });
    await page.getByRole("button", { name: "repository path", exact: true }).click();
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "other local path", exact: true }).click();
    await expect(page.locator(".file-source")).toContainText("newest-file-only");
    for (const release of releases.splice(0)) release();
    await expect.poll(() => pending).toBe(0);
    await expect(page.locator(".file-source")).not.toContainText("child-diff-new");
    await page.getByRole("button", { name: "repository path", exact: true }).click();
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Close surfaces", exact: true }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    for (const release of releases.splice(0)) release();
    await expect.poll(() => pending).toBe(0);
    await expect(page).toHaveURL(/#\/settings/);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Subfolder browser", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Surfaces", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Search files", exact: true })).toBeVisible();
    await expect(page.locator(".file-source")).toHaveCount(0);
    expect(releases).toHaveLength(0);
  } finally {
    for (const release of releases.splice(0)) release();
    await f.service.stop();
  }
});

test("a moved thread rejects a file-link lookup captured at its old cwd", async ({ page }) => {
  const f = await fixture();
  const releases: (() => void)[] = [];
  let pending = 0;
  try {
    const target = await f.service.api<{ id: string }>("POST", "/api/projects/add", { path: join(f.service.repo, "packages/api") });
    await f.service.api("POST", `/api/projects/${target.id}/trust`);
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(`${f.service.page}#/threads/${f.thread.id}`);
    await page.getByRole("button", { name: "Surfaces", exact: true }).click();
    await page.locator(".launcher").getByRole("button", { name: /Files/ }).click();
    await page.locator(".file-tree button").filter({ hasText: "links.md" }).first().click();
    await expect(page.getByRole("button", { name: "move link", exact: true })).toBeVisible();
    await page.route(`**/api/threads/${f.thread.id}/paths/resolve`, async (route) => {
      pending += 1;
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
        if (!route.request().failure()) await route.continue();
      } finally { pending -= 1; }
    });
    const reply = page.waitForResponse((response) => response.url().endsWith("/paths/resolve"));
    await page.getByRole("button", { name: "move link", exact: true }).click();
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    const moved = await f.service.api<{ cwd: string }>("POST", `/api/threads/${f.thread.id}/project`, { project_id: target.id });
    expect(moved.cwd).not.toBe(f.thread.cwd);
    for (const release of releases.splice(0)) release();
    expect((await reply).status()).toBe(409);
    await expect.poll(() => pending).toBe(0);
    await expect(page.locator(".file-source")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "move link", exact: true })).toBeVisible();
  } finally {
    for (const release of releases.splice(0)) release();
    await f.service.stop();
  }
});
