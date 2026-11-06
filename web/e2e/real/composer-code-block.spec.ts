import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** B5: a fenced block in the real composer keeps its own Tab, Enter and language rules. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const caret = (page: Page) =>
  box(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]);
const selected = (page: Page) =>
  box(page).evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd));
const select = (page: Page, start: number, end = start) =>
  box(page).evaluate((element: HTMLTextAreaElement, [from, to]: [number, number]) => element.setSelectionRange(from, to), [start, end] as [number, number]);

test("Tab, Shift+Tab, Enter, the language picker and Mod+Enter follow the code block rules", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:usage] code block");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  const runs: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith(`/api/threads/${id}/runs`)) runs.push(sent.url());
  });

  const language = page.getByRole("combobox", { name: "Code block language" });
  await box(page).fill("```");
  await expect(language).toBeVisible();
  // Inside a block, Enter adds a line rather than sending.
  await box(page).press("End");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("```\n");
  expect(await caret(page)).toEqual([4, 4]);
  await page.keyboard.type("const a = 1;");

  // Tab nests the caret's line two spaces and moves the caret with it.
  await select(page, 7);
  await box(page).press("Tab");
  await expect(box(page)).toHaveValue("```\n  const a = 1;");
  expect(await caret(page)).toEqual([9, 9]);
  await expect(box(page)).toBeFocused();
  await box(page).press("Shift+Tab");
  await expect(box(page)).toHaveValue("```\nconst a = 1;");
  expect(await caret(page)).toEqual([7, 7]);

  // A selection across lines moves every line it touches.
  await select(page, "```\nconst a = 1;".length);
  await box(page).press("Enter");
  await page.keyboard.type("return a;");
  await expect(box(page)).toHaveValue("```\nconst a = 1;\nreturn a;");
  await select(page, 5, "```\nconst a = 1;\nret".length);
  await box(page).press("Tab");
  await expect(box(page)).toHaveValue("```\n  const a = 1;\n  return a;");
  // The selection stays on the same text, so the keys can repeat over it.
  expect(await selected(page)).toBe("onst a = 1;\n  ret");
  await box(page).press("Shift+Tab");
  await expect(box(page)).toHaveValue("```\nconst a = 1;\nreturn a;");
  expect(await selected(page)).toBe("onst a = 1;\nret");

  // The picker names, renames and clears the language on the opening fence.
  await expect(language).toHaveValue("");
  await language.selectOption("javascript");
  await expect(box(page)).toHaveValue("```javascript\nconst a = 1;\nreturn a;");
  await language.selectOption("python");
  await expect(box(page)).toHaveValue("```python\nconst a = 1;\nreturn a;");
  await language.selectOption("");
  await expect(box(page)).toHaveValue("```\nconst a = 1;\nreturn a;");
  await language.selectOption("typescript");
  // A language typed by hand that the list lacks is still offered and kept.
  await box(page).fill("```zig\nconst a = 1;\nreturn a;");
  await select(page, 8);
  await expect(language).toHaveValue("zig");
  await box(page).fill("```typescript\nconst a = 1;\nreturn a;");

  // Enter on a filled last line adds one; Enter on that empty last line closes the block.
  const body = "```typescript\nconst a = 1;\nreturn a;";
  await select(page, body.length);
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue(`${body}\n`);
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue(`${body}\n\`\`\`\n`);
  expect(await caret(page)).toEqual([body.length + 5, body.length + 5]);
  await expect(language).toBeHidden();
  await page.keyboard.type("Explain it.");
  const draft = `${body}\n\`\`\`\nExplain it.`;
  await expect(box(page)).toHaveValue(draft);
  expect(runs).toEqual([]);

  // Back inside the block, plain Enter still never sends; Mod+Enter does.
  // The arrow keys move the caret the way a person would, up into the block body.
  await box(page).press("ArrowUp");
  await box(page).press("ArrowUp");
  await box(page).press("ArrowUp");
  // Lines wrap by font, so only the line is fixed: the block's first body line.
  const [at] = await caret(page);
  expect(at).toBeGreaterThan("```typescript".length);
  expect(at).toBeLessThanOrEqual("```typescript\nconst a = 1;".length);
  await expect(language).toHaveValue("typescript");
  const request = page.waitForRequest((sent) => sent.method() === "POST" && sent.url().endsWith(`/api/threads/${id}/runs`));
  await box(page).press("ControlOrMeta+Enter");
  const { prompt } = (await request).postDataJSON() as { prompt: string };
  expect(prompt).toBe(draft);
  await settled(service, id);
  await expect(box(page)).toHaveValue("");
});
