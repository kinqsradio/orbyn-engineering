import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/**
 * B45: a chip copied from one thread's composer comes back as a chip when pasted
 * into another's, through Chromium's real clipboard and `ClipboardItem`.
 */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const chips = (page: Page) => page.getByRole("list", { name: "Context chips", exact: true });
const visit = (page: Page, thread: string) =>
  page.evaluate((hash) => {
    location.hash = hash;
  }, `#/threads/${thread}`);

async function fresh(page: Page, prompt: string) {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  return id;
}

async function pasteInto(page: Page, thread: string) {
  await visit(page, thread);
  await expect(page).toHaveURL(new RegExp(thread));
  await box(page).click();
  await page.keyboard.press("ControlOrMeta+v");
}

test("copied chips paste as chips in another composer, files refetch, and text stays text", async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(service.page).origin });
  const target = await fresh(page, "[scene:usage] paste target");
  const third = await fresh(page, "[scene:usage] paste all");
  const source = await fresh(page, "[scene:cite] copy source");

  // Two chips in the source composer: a cited reply and a file with its text.
  const reply = page.locator(".msg-assistant").filter({ hasText: "Beta sentence about retries." }).last();
  await reply.hover();
  await reply.getByRole("button", { name: "Cite in your message" }).click();
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search" }).fill("README.md");
  await palette.getByRole("button", { name: /README\.md/ }).first().click();
  await page.locator(".files-viewer").getByRole("button", { name: "Add file to message" }).click();
  await expect(chips(page).locator("li[data-kind]")).toHaveCount(2);

  await chips(page).getByRole("button", { name: "Copy citation chip" }).click();
  await expect(page.getByText("Chip copied")).toBeVisible();
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return item ? { types: item.types, html: await (await item.getType("text/html")).text() } : null;
  });
  expect(copied?.types).toEqual(expect.arrayContaining(["text/plain", "text/html"]));
  expect(copied?.html).toContain("data-orbyn-composer");
  await pasteInto(page, target);
  await expect(chips(page).locator("li[data-kind=citation]")).toContainText("Alpha sentence about caching.");
  await expect(box(page)).toHaveValue("");

  await visit(page, source);
  await chips(page).getByRole("button", { name: "Copy file chip" }).click();
  await pasteInto(page, target);
  await expect(chips(page).locator("li[data-kind=file]")).toContainText("README.md");
  // The source keeps its own chips, and Copy all carries both in one paste.
  await visit(page, source);
  await expect(chips(page).locator("li[data-kind]")).toHaveCount(2);
  await chips(page).getByRole("button", { name: "Copy all chips" }).click();
  await pasteInto(page, third);
  await expect(chips(page).locator("li[data-kind]")).toHaveCount(2);
  await expect(chips(page).locator("li[data-kind=citation]")).toContainText("Alpha sentence about caching.");
  await expect(chips(page).locator("li[data-kind=file]")).toContainText("README.md");

  // A copy whose file text was not carried is read again from the target's checkout.
  await page.evaluate(() => {
    const payload = JSON.stringify({ version: 1, chips: [{ kind: "file", path: "README.md", line: null, excerpt: null, language: "markdown" }] });
    const html = `<div data-orbyn-composer="${payload.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"><ul><li>README.md</li></ul></div>`;
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob(["File `README.md`"], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  });
  const read = page.waitForRequest((sent) => sent.url().includes(`/api/threads/${target}/files/content`));
  await pasteInto(page, target);
  expect(new URL((await read).url()).searchParams.get("path")).toBe("README.md");
  await expect(chips(page).locator("li[data-kind=file]")).toHaveCount(2);

  // Plain text that looks like a chip copy is pasted as text.
  const lookalike = JSON.stringify({ version: 1, chips: [{ kind: "citation", threadId: source, text: "fake" }] });
  await page.evaluate((text) => navigator.clipboard.writeText(text), lookalike);
  await pasteInto(page, target);
  await expect(box(page)).toHaveValue(lookalike);
  await expect(chips(page).locator("li[data-kind]")).toHaveCount(3);

  await box(page).fill("Use these");
  const request = page.waitForRequest((sent) => sent.method() === "POST" && sent.url().endsWith(`/api/threads/${target}/runs`));
  await box(page).press("Enter");
  const { prompt } = (await request).postDataJSON() as { prompt: string };
  expect(prompt).toBe(
    [
      "> Alpha sentence about caching.\n>\n> Beta sentence about retries.",
      "File `README.md`\n```markdown\n# Repo\n```",
      "File `README.md`\n```markdown\n# Repo\n```",
      "Use these",
    ].join("\n\n"),
  );
  await settled(service, target);
});
