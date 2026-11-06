import { expect, test } from "@playwright/test";
import { send, settled, startProject } from "./service";

/** The engine's own console opens in an Orbyn terminal on the thread's session. */

test("the engine console resumes the thread's session and holds runs until it closes", async ({ page }) => {
  test.setTimeout(90_000);
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "claude", title: "Console source" });
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const drawer = page.locator(".terminal-drawer-body");
    const consoleButton = page.getByRole("button", { name: "Open engine console", exact: true });

    // No session yet: the service says so and opens nothing.
    await consoleButton.click();
    await expect(page.getByText(/no Claude Code session yet/)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Claude console" })).toHaveCount(0);

    await send(page, "hello");
    await settled(service, thread.id);
    await consoleButton.click();
    const tab = page.getByRole("tab", { name: "Claude console" });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const rows = drawer.locator(".xterm-rows > div");
    await expect(rows.filter({ hasText: "fake console on claude-session-1" }).first()).toBeVisible({ timeout: 20_000 });
    await drawer.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("are you there\n");
    await expect(rows.filter({ hasText: "console heard are you there" }).first()).toBeVisible();

    // While the console owns the session, a turn is refused and the draft stays.
    const box = page.getByRole("textbox", { name: /^Message/ });
    await box.fill("second turn");
    await box.press("Enter");
    await expect(page.getByText(/Close this thread's engine console first/).first()).toBeVisible();
    await expect(box).toHaveValue("second turn");

    await page.getByRole("button", { name: "Close Claude console", exact: true }).click();
    await expect(tab).toHaveCount(0);
    await send(page, "second turn");
    await settled(service, thread.id);
  } finally {
    await service.stop();
  }
});
