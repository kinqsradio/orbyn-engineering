import { expect, test, type Locator, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/**
 * B40: when the shell marks its commands (OSC 133/633, as an integrated shell
 * does), a terminal chip carries the command and its exit code; output the shell
 * did not mark stays a plain selection.
 */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

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

async function selectWord(page: Page, line: Locator) {
  const place = await line.boundingBox();
  if (!place) throw new Error("no line");
  await page.mouse.dblclick(place.x + 6, place.y + place.height / 2);
}

test("a selection in marked command output carries the command and exit code into the prompt", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:usage] command chips");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".terminal-drawer-body .xterm-helper-textarea").first()).toBeVisible();

  // The marks an integrated shell prints around one command: its line, output start, and exit.
  const marked = await run(
    page,
    "printf '\\033]633;E;echo MARKED_OUTPUT\\a\\033]133;C\\a'; echo MARKED_OUTPUT; printf '\\033]133;D;3\\a'\n",
    /^MARKED_OUTPUT\s*$/,
  );
  const plain = await run(page, "echo PLAIN_OUTPUT\n", /^PLAIN_OUTPUT\s*$/);
  const chips = page.getByRole("list", { name: "Context chips", exact: true });
  const add = page.getByRole("button", { name: "Add selection", exact: true });

  await selectWord(page, marked);
  await add.click();
  await expect(chips.locator("li[data-kind=terminal]")).toHaveCount(1);
  await expect(chips.locator("li[data-kind=terminal]")).toContainText(/Terminal selection line \d+ · exit 3/);

  await selectWord(page, plain);
  await add.click();
  await expect(chips.locator("li[data-kind=terminal]")).toHaveCount(2);
  await expect(chips.locator("li[data-kind=terminal]").nth(1)).not.toContainText("exit");

  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill("[scene:usage] what failed");
  const request = page.waitForRequest((sent) => sent.method() === "POST" && sent.url().endsWith(`/api/threads/${id}/runs`));
  await box.press("Enter");
  const { prompt } = (await request).postDataJSON() as { prompt: string };
  expect(prompt).toMatch(
    /^Terminal selection line \d+\nCommand: `echo MARKED_OUTPUT` \(exit code 3\)\n```\nMARKED_OUTPUT\n```\n\nTerminal selection line \d+\n```\nPLAIN_OUTPUT\n```\n\n\[scene:usage\] what failed$/,
  );
  await settled(service, id);
});
