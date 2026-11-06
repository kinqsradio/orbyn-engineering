import { expect, test } from "@playwright/test";
import { send, settled, startProject, type Service } from "./service";

/** A Claude Code workflow through the real service: its script opens, and Stop ends it. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("a running workflow shows its script and stops", async ({ page }) => {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: "claude",
    model: null,
    title: "Workflow",
    worktree: null,
    skill_profile: null,
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await send(page, "go [workflow]");

  const card = page.getByLabel("Workflow probe");
  await expect(card.getByText("Running")).toBeVisible();
  await card.getByRole("button", { name: "View script" }).click();
  const dialog = page.getByRole("dialog", { name: "probe script" });
  await expect(dialog.getByText("await agent('look')")).toBeVisible();
  await dialog.getByRole("button", { name: /close/i }).first().click();

  await card.getByRole("button", { name: "Stop workflow" }).click();
  await expect(card.getByText("Stopped")).toBeVisible();
  await expect(card.getByRole("button", { name: "Stop workflow" })).toHaveCount(0);
  await settled(service, thread.id);
});
