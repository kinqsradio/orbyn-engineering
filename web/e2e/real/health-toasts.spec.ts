import { expect, test } from "@playwright/test";
import { startProject, startService } from "./service";

/**
 * The two health toasts through the real service. That a start which upgrades a database
 * reports it is proved in Core's store tests; this proves what the browser does with it.
 */

interface Info {
  database_upgrade?: { from: number; to: number } | null;
}

test("a reported database upgrade is announced once and not after a reload", async ({ page }) => {
  const service = await startService();
  try {
    // The real response, with the upgrade a start from the previous schema would add.
    const info = await service.api<Info>("GET", "/api/info");
    await page.route("**/api/info", (route) => route.fulfill({ json: { ...info, database_upgrade: { from: 41, to: 42 } } }));
    await page.goto(service.page);
    const toast = page.getByText("Orbyn updated its database (version 41 to 42). Your threads and settings were kept.");
    await expect(toast).toHaveCount(1);
    await expect(toast).toBeHidden({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expect(page.getByText(/Orbyn updated its database/)).toHaveCount(0);
  } finally {
    await service.stop();
  }
});

test("a permission change during a live run is noted in the thread and toasted", async ({ page }) => {
  const { service, projectId, engines } = await startProject({ fakeEngines: true });
  try {
    const thread = await service.api<{ id: string }>("POST", "/api/threads", {
      project_id: projectId,
      engine: engines[0]?.id,
      model: null,
      title: "Live permissions",
      worktree: null,
      skill_profile: null,
    });
    await service.api("POST", `/api/threads/${thread.id}/runs`, { prompt: "[hang]" });
    await expect
      .poll(async () => (await service.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${thread.id}`)).active_run?.state)
      .toBe("running");

    await page.goto(`${service.page}#/threads/${thread.id}`);
    await expect(page.getByRole("status").filter({ hasText: /^Working for/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Permission mode changed/)).toHaveCount(0);

    await service.api("PATCH", `/api/threads/${thread.id}`, { permission_mode: "full_access" });
    await expect(page.getByText("Permission mode changed; it applies from the next turn.")).toBeVisible();
    await expect(
      page.getByText("Permission mode is now Full access. The running turn keeps its mode; the next turn uses the new one."),
    ).toBeVisible();
  } finally {
    await service.stop();
  }
});
