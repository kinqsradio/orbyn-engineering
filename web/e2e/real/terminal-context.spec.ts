import { expect, test, type Page } from "@playwright/test";
import { settled, startProject } from "./service";

async function selectOutput(page: Page) {
  const row = page.locator(".terminal-drawer-body .xterm-rows > div").filter({ hasText: /^CONTEXT_SENTINEL$/ }).first();
  await expect(row).toBeVisible();
  const bounds = await row.boundingBox();
  if (!bounds) throw new Error("Terminal output has no bounds");
  const cell = await row.locator("span").first().evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    return range.getBoundingClientRect().width / (span.textContent?.length ?? 1);
  });
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + cell * "CONTEXT_SENTINEL".length, y, { steps: 12 });
  await page.mouse.up();
  await page.getByRole("menuitem", { name: "Add to chat", exact: true }).click();
}

test("explicit terminal selection survives navigation and sends its captured text", async ({ page }, info) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: {
      default_project_scripts: [{ name: "Excerpt output", command: "echo CONTEXT_SENTINEL" }],
    } });
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Context source" });
    const other = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Other thread" });
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await page.getByRole("complementary", { name: "Thread details" }).getByRole("button", { name: "Excerpt output", exact: true }).click();
    await selectOutput(page);
    const chips = page.getByRole("list", { name: "Terminal context", exact: true });
    await expect(chips).toContainText("Excerpt output line");
    await chips.getByRole("button", { name: /Show details/ }).click();
    await expect(page.getByLabel("Captured terminal output", { exact: true })).toHaveText("CONTEXT_SENTINEL");
    await page.screenshot({ path: info.outputPath("terminal-excerpt-preview.png") });
    await chips.getByRole("button", { name: /Remove terminal excerpt/ }).click();
    await expect(chips).toHaveCount(0);
    await selectOutput(page);

    await page.getByText("Other thread", { exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(other.id));
    await expect(chips).toHaveCount(0);
    await page.getByText("Context source", { exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(thread.id));
    await expect(chips).toContainText("Excerpt output line");
    // Exercise a rightmost chip at a narrow viewport, then remove only the extras.
    await selectOutput(page);
    await selectOutput(page);
    await page.setViewportSize({ width: 720, height: 720 });
    // At narrow widths the existing terminal surface takes over the thread.
    await page.getByRole("button", { name: "Close terminal", exact: true }).click();
    const lastChip = chips.getByRole("button", { name: /Show details/ }).last();
    await lastChip.click();
    const preview = page.getByLabel("Captured terminal output", { exact: true });
    await expect(preview).toBeVisible();
    const previewBounds = await preview.boundingBox();
    expect(previewBounds).not.toBeNull();
    expect(previewBounds!.x).toBeGreaterThanOrEqual(0);
    expect(previewBounds!.x + previewBounds!.width).toBeLessThanOrEqual(720);
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(lastChip).toBeFocused();
    await page.screenshot({ path: info.outputPath("terminal-context-narrow.png") });
    await chips.getByRole("button", { name: /Remove terminal excerpt/ }).last().click();
    await chips.getByRole("button", { name: /Remove terminal excerpt/ }).last().click();
    const box = page.getByRole("textbox", { name: /^Message/ });
    await box.fill("explain this output");
    const request = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(`/api/threads/${thread.id}/runs`));
    await box.press("Enter");
    const payload = (await request).postDataJSON() as { prompt: string };
    expect(payload.prompt).toContain("explain this output");
    expect(payload.prompt).toContain("Terminal excerpt: Excerpt output line");
    expect(payload.prompt).toContain("CONTEXT_SENTINEL");
    await settled(service, thread.id);
    await expect(chips).toHaveCount(0);
    await expect(page.locator(".transcript")).toContainText("CONTEXT_SENTINEL");
  } finally { await service.stop(); }
});
