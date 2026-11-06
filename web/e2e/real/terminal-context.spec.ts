import { expect, test, type Locator, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** A terminal excerpt becomes a composer chip and reaches the engine as plain prompt text. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

const fresh = async (page: Page, prompt: string) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  return id;
};

/** Types until the shell answers, since a shell still starting can lose what is typed. */
async function run(page: Page, command: string, output: RegExp): Promise<Locator> {
  const input = page.locator(".terminal-drawer-body .xterm-helper-textarea").first();
  const line = page.locator(".terminal-drawer-body .xterm-rows > div").filter({ hasText: output }).first();
  await expect(async () => {
    await input.focus();
    await page.keyboard.type(command);
    await expect(line).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 25_000 });
  return line;
}

/** Double-clicking a word is xterm's own selection gesture. */
async function selectWord(page: Page, line: Locator) {
  const place = await line.boundingBox();
  if (!place) throw new Error("no line");
  await page.mouse.dblclick(place.x + 6, place.y + place.height / 2);
}

test("a terminal selection becomes a chip that survives navigation and is sent as text", async ({ page }) => {
  test.setTimeout(90_000);
  const other = await fresh(page, "[scene:usage] other thread");
  const id = await fresh(page, "[scene:usage] context source");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".terminal-drawer-body .xterm-helper-textarea").first()).toBeVisible();
  const line = await run(page, "echo CONTEXT_SENTINEL\n", /^CONTEXT_SENTINEL\s*$/);
  const add = page.getByRole("button", { name: "Add selection", exact: true });
  await expect(add).toBeDisabled();
  await selectWord(page, line);
  await expect(add).toBeEnabled();
  await add.click();

  const chips = page.getByRole("list", { name: "Context chips", exact: true });
  const chip = chips.locator("li[data-kind=terminal]");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText(/Terminal selection line \d+/);

  // Removing the chip leaves the selection to add again.
  await chips.getByRole("button", { name: "Remove terminal chip" }).click();
  await expect(chip).toHaveCount(0);
  await selectWord(page, line);
  await add.click();
  await expect(chip).toHaveCount(1);

  // Chips belong to their thread, across in-app navigation.
  const visit = (thread: string) => page.evaluate((hash) => { location.hash = hash; }, `#/threads/${thread}`);
  await visit(other);
  await expect(page).toHaveURL(new RegExp(other));
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
  await expect(chip).toHaveCount(0);
  await visit(id);
  await expect(chip).toHaveCount(1);

  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill("[scene:usage] explain this output");
  const request = page.waitForRequest((sent) => sent.method() === "POST" && sent.url().endsWith(`/api/threads/${id}/runs`));
  await box.press("Enter");
  const { prompt } = (await request).postDataJSON() as { prompt: string };
  expect(prompt).toMatch(/^Terminal selection line \d+\n```\nCONTEXT_SENTINEL\n```\n\n\[scene:usage\] explain this output$/);
  await settled(service, id);
  await expect(chip).toHaveCount(0);
});
