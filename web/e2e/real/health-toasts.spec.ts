import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { startProject, startService, type Service } from "./service";

/** The two health toasts through the real service: a database upgrade, and a permission change during a live run. */

interface Info {
  database_upgrade?: { from: number; to: number } | null;
}

test("an upgraded database is announced once and not after a reload", async ({ page }) => {
  const first = await startService();
  const home = dirname(first.dataDir);
  let second: Service | undefined;
  try {
    expect((await first.api<Info>("GET", "/api/info")).database_upgrade ?? null).toBeNull();
    await first.stop(true);
    // The newest migration only creates a table, so removing it leaves a database one version behind.
    const db = new DatabaseSync(join(first.dataDir, "orbyn.sqlite3"));
    try {
      const { latest } = db.prepare("SELECT MAX(version) AS latest FROM schema_migrations").get() as { latest: number };
      expect(latest, "the migration this fixture rolls back changed; pick the newest one that only creates a table").toBe(24);
      db.exec("DROP TABLE pull_guides");
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latest);
    } finally {
      db.close();
    }

    second = await startService({ dataDir: first.dataDir });
    expect((await second.api<Info>("GET", "/api/info")).database_upgrade).toEqual({ from: 23, to: 24 });

    await page.goto(second.page);
    const toast = page.getByText("Orbyn updated its database (version 23 to 24). Your threads and settings were kept.");
    await expect(toast).toHaveCount(1);
    await expect(toast).toBeHidden({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expect(page.getByText(/Orbyn updated its database/)).toHaveCount(0);
    // The service reports the same upgrade until its next start; the page keeps it quiet.
    expect((await second.api<Info>("GET", "/api/info")).database_upgrade).toEqual({ from: 23, to: 24 });
  } finally {
    await second?.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
