import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/__mock/scenario/default");
});

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
  [320, 740],
]) {
  test(`no page overflow at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    for (const hash of ["#/threads/t-done", "#/new", "#/settings/audit", "#/settings/policy", "#/approvals"]) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() =>
        Math.max(
          ...[document.documentElement, ...document.querySelectorAll<HTMLElement>(".main, .transcript, .settings-main")].map(
            (element) => element.scrollWidth - element.clientWidth,
          ),
        ),
      );
      expect(overflow, hash).toBe(0);
    }
  });
}

test("token moves out of the URL", async ({ page }) => {
  await page.goto("/?token=abc#/");
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  expect(page.url()).not.toContain("token");
  expect(await page.evaluate(() => sessionStorage.getItem("orbyn.token"))).toBe("abc");
});

test("a dropped stream shows reconnecting and loses nothing", async ({ page }) => {
  await page.goto("/#/threads/t-empty");
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill("stream please");
  await box.press("Enter");
  await expect(page.getByText("Reasoning")).toBeVisible();
  await page.evaluate(() => fetch("/__mock/drop-streams"));
  await expect(page.getByText(/^Reconnecting/)).toBeVisible();
  await expect(page.locator(".thread-state")).toHaveText("Completed", { timeout: 10_000 });
  await expect(page.locator(".msg-assistant")).toContainText("Stop the run with Cancel, or wait for it to finish.");
});

test("the terminal connects and sizes itself without WebGL", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(page.locator(".terminal-panel .pill")).toHaveText("Connected");
  await expect(page.locator(".xterm-rows")).toContainText("resized to");
  expect(await page.locator(".xterm canvas").count()).toBe(0);
});

test("narrow layout is one surface with a way back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("link", { name: /Explain how the event log/ }).click();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeHidden();
  await page.getByRole("button", { name: /Open diff/ }).click();
  await expect(page.getByRole("tablist", { name: "Context" })).toBeVisible();
  await page.getByRole("button", { name: "Back to thread" }).click();
  await page.getByRole("link", { name: "Back to threads" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
});

test("Escape closes a dialog and returns focus to its opener", async ({ page }) => {
  await page.goto("/#/settings/engines");
  const open = page.getByRole("button", { name: "Update to 2.1.20" });
  await open.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(open).toBeFocused();
});

test("keyboard focus is visible and reduced motion stops animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/threads/t-approval");
  await expect(page.locator(".thread-state")).toHaveText("Waiting for you");
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
  expect(outline).toBe("solid");
  const duration = await page.evaluate(() => getComputedStyle(document.querySelector(".spin") as Element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.01);
});
