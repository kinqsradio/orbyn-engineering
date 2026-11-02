//! A delayed real projects snapshot must not overwrite committed project metadata.
import { expect, test } from "@playwright/test";
import type { Project } from "../../src/generated/Project";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";
import { startProject } from "./service";

test("a committed icon survives an older in-flight project refresh", async ({ page }, info) => {
  const { service, projectId } = await startProject();
  await page.clock.install({ time: new Date("2026-11-02T08:00:00Z") });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let captured!: () => void;
  const snapshotCaptured = new Promise<void>((resolve) => { captured = resolve; });
  let fulfilled!: () => void;
  const snapshotFulfilled = new Promise<void>((resolve) => { fulfilled = resolve; });
  let armed = false;
  const snapshot: { projects?: Project[]; heldCount: number } = { heldCount: 0 };
  await page.route("**/api/projects", async (route) => {
    if (!armed || route.request().method() !== "GET") { await route.continue(); return; }
    armed = false;
    const response = await route.fetch();
    snapshot.projects = await response.json() as Project[];
    snapshot.heldCount += 1;
    captured();
    await held;
    // The held response is replayed intact, with its actual older metadata.
    await route.fulfill({ response });
    fulfilled();
  });
  try {
    const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
    const group = catalog.groups.find((entry) => entry.members.some((member) => member.project_id === projectId))!;
    await page.goto(`${service.page}#/settings/projects?project=${encodeURIComponent(group.key)}`);
    await page.getByRole("button", { name: "Choose a project icon", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose project icon", exact: true });
    await picker.getByRole("button", { name: "Emoji", exact: true }).click();
    await picker.getByRole("button", { name: "Robot", exact: true }).click();
    armed = true;
    // One due poll fires; no later poll can mask a stale response while paused.
    await page.clock.pauseAt(new Date("2026-11-02T09:00:00Z"));
    await snapshotCaptured;
    const before = snapshot.projects!.find((project) => project.id === projectId)!;
    expect(before.project_icon ?? null).toBeNull();
    const responseFinished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "GET");
    await picker.getByRole("button", { name: "Save icon", exact: true }).click();
    await expect(picker).toHaveCount(0);
    const identity = page.getByRole("link", { name: `New thread in ${before.name}`, exact: true }).locator(".project-icon-visual");
    await expect(identity).toHaveText("🤖");
    const committed = (await service.api<Project[]>("GET", "/api/projects")).find((project) => project.id === projectId)!;
    expect(committed.project_icon).toEqual({ kind: "emoji", emoji: "🤖" });
    expect(committed.metadata_revision).not.toBe(before.metadata_revision);
    await info.attach("real-refresh-and-commit", { body: JSON.stringify({ before, committed }), contentType: "application/json" });
    release();
    await snapshotFulfilled;
    await (await responseFinished).finished();
    await page.clock.runFor(50);
    expect(snapshot.heldCount).toBe(1);
    await expect(identity).toHaveText("🤖");
    await page.screenshot({ path: info.outputPath("icon-after-older-refresh.png") });
  } finally { release(); await service.stop(); }
});
