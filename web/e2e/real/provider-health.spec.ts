import { expect, test } from "@playwright/test";
import type { EngineStatus } from "../../src/api/types";
import { startProject, type Service } from "./service";

let service: Service;
let projectId: string;
test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
});
test.afterAll(() => service.stop());

// Status fixtures prove presentation against orbynd; no authenticated probe is claimed.
test("the composer follows provider health reports and recovery", async ({ page }, info) => {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId, engine: "codex", model: null, worktree: null, skill_profile: null,
  });
  let status: Partial<EngineStatus> = { problem: "This engine did not respond." };
  await page.route("**/api/engines", async (route) => {
    const response = await route.fetch();
    const engines = await response.json() as EngineStatus[];
    await route.fulfill({ response, json: engines.map((engine) => engine.id === "codex" ? { ...engine, ...status } : engine) });
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  const recheck = async () => {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections", exact: true }).getByRole("link", { name: "Providers", exact: true }).click();
    const check = page.getByRole("button", { name: "Check again", exact: true });
    await check.click();
    await expect(check).toBeEnabled();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeHidden();
  };
  const banner = page.locator(".composer-banner");
  await expect(banner).toHaveText("Codex: This engine did not respond.");
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill("Keep this unsent draft");
  await page.screenshot({ path: info.outputPath("composer-provider-failure.png") });
  status = { installed: false, auth: "unknown", problem: null };
  await recheck();
  await expect(banner).toContainText("isn't installed");
  status = { installed: true, auth: "logged_out", problem: null };
  await recheck();
  await expect(banner).toContainText("is signed out");
  status = { installed: true, auth: "unknown", problem: null, updating: true };
  await recheck();
  await expect(banner).toContainText("is updating");
  status = { installed: true, auth: "unknown", problem: null, updating: false };
  await recheck();
  await expect(banner).toHaveCount(0);
  await expect(box).toBeVisible();
  await expect(box).toHaveValue("Keep this unsent draft");
  await page.screenshot({ path: info.outputPath("composer-provider-recovered.png") });
});
