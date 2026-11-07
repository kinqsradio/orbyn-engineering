import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => localStorage.setItem("orbyn.prefs.v1", JSON.stringify({
    layouts: { "t-done": { panelOpen: false, panelTab: null, openSurfaces: [], terminalOpen: false, panelMaximized: false, panelWidth: null, sideChat: null } },
  })));
  await page.goto("/__mock/scenario/default?to=/%23/threads/t-done");
  await expect(page.locator(".transcript-inner")).toBeVisible();
  await expect(page.getByRole("button", { name: "Surfaces" })).toBeVisible();
});

async function expectAligned(page: Page) {
  const bounds = await page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript-inner")!;
    const composer = document.querySelector<HTMLElement>(".composer-box")!;
    const rect = transcript.getBoundingClientRect();
    const style = getComputedStyle(transcript);
    const box = composer.getBoundingClientRect();
    return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight), composerLeft: box.left, composerRight: box.right };
  });
  expect(Math.abs(bounds.left - bounds.composerLeft)).toBeLessThan(1);
  expect(Math.abs(bounds.right - bounds.composerRight)).toBeLessThan(1);
}

for (const layout of ["console", "ledger", "reading"]) {
  test(`${layout} aligns the composer with the transcript through details and pane resizing`, async ({ page }) => {
    await page.evaluate((value) => { document.documentElement.dataset.workspace = value; }, layout);
    const details = page.getByRole("button", { name: "Details", exact: true });
    for (const width of [1600, 1200]) {
      await page.setViewportSize({ width, height: 900 });
      for (const shown of [false, true]) {
        if ((await details.getAttribute("aria-pressed")) !== String(shown)) await details.click();
        await expect(details).toHaveAttribute("aria-pressed", String(shown));
        await expectAligned(page);
      }
    }
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByRole("button", { name: "Surfaces" }).click();
    const handle = page.getByRole("separator", { name: "Resize panel" });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 120);
    await page.mouse.down();
    await page.mouse.move(box!.x - 180, box!.y + 120, { steps: 8 });
    await page.mouse.up();
    await expectAligned(page);
  });
}

test("dragging the surface divider does not select page text", async ({ page }) => {
  await page.getByRole("button", { name: "Surfaces" }).click();
  const handle = page.getByRole("separator", { name: "Resize panel" });
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 120);
  await page.mouse.down();
  await page.mouse.move(box!.x - 180, box!.y + 300, { steps: 8 });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  const text = page.getByText("Explain how the event log resumes after a reconnect. Include the edge cases.");
  await text.dblclick();
  expect(await page.evaluate(() => getSelection()?.toString().length)).toBeGreaterThan(0);
});
