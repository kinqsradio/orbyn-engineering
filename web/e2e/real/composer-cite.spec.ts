import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** B28: a finished reply is cited into the composer and sent with the typed comment. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });

async function sentPrompt(page: Page, id: string, text: string): Promise<string> {
  await box(page).fill(text);
  const request = page.waitForRequest((sent) => sent.method() === "POST" && sent.url().endsWith(`/api/threads/${id}/runs`));
  await box(page).press("Enter");
  const { prompt } = (await request).postDataJSON() as { prompt: string };
  await settled(service, id);
  return prompt;
}

test("a selection in a reply is cited above the composer and sent before the comment", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:cite] tell me two things");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);

  const reply = page.locator(".msg-assistant").filter({ hasText: "Beta sentence about retries." }).last();
  await expect(reply).toBeVisible();
  // Drag across the second paragraph the way a person selects it.
  const beta = reply.getByText("Beta sentence about retries.", { exact: true });
  const place = await beta.boundingBox();
  if (!place) throw new Error("no paragraph");
  await page.mouse.move(place.x + 1, place.y + place.height / 2);
  await page.mouse.down();
  await page.mouse.move(place.x + place.width - 1, place.y + place.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toMatch(/^Beta sentence about retries\.?$/);

  await reply.hover();
  await reply.getByRole("button", { name: "Cite in your message" }).click();
  const chips = page.getByRole("list", { name: "Context chips", exact: true });
  const chip = chips.locator("li[data-kind=citation]");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("Beta sentence about retries");
  await expect(chip).not.toContainText("Alpha");

  const prompt = await sentPrompt(page, id, "Why retries?");
  expect(prompt).toMatch(/^> Beta sentence about retries\.?\n\nWhy retries\?$/);
  await expect(chips).toHaveCount(0);
  // The service keeps the quote and the comment as the sent message.
  const messages = JSON.stringify(await service.api("GET", `/api/threads/${id}/messages?limit=20`));
  expect(messages).toContain("> Beta sentence about retries");
  expect(messages).toContain("Why retries?");
});

test("with nothing selected, Cite quotes the whole reply", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:cite] once more");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const reply = page.locator(".msg-assistant").filter({ hasText: "Beta sentence about retries." }).last();
  await reply.hover();
  await reply.getByRole("button", { name: "Cite in your message" }).click();
  await expect(page.getByRole("list", { name: "Context chips", exact: true }).locator("li[data-kind=citation]")).toContainText("Alpha sentence");
  const prompt = await sentPrompt(page, id, "Summarise both.");
  expect(prompt).toBe("> Alpha sentence about caching.\n>\n> Beta sentence about retries.\n\nSummarise both.");
});
