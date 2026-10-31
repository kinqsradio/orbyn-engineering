import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Composer rows through the real service: limits, uploads, the queue and commands. */
const PORT = 5285;

let service: Service;
let projectId = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const started = async (page: Page, prompt: string) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  return threadIdOf(page);
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject(PORT, { scenes: true }));
});
test.afterAll(() => service.stop());

test("an oversize message stays in the composer and cannot be sent", async ({ page }) => {
  const id = await started(page, "[scene:usage] hello");
  await settled(service, id);
  await box(page).fill("x".repeat(120_003));
  await expect(page.getByRole("alert")).toContainText("3 characters over the 120,000 limit");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await box(page).press("Enter");
  await expect(box(page)).not.toHaveValue("");
  await box(page).fill("x".repeat(120_000));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await box(page).fill("");
});

test("an upload starts on add, a refused one can be removed, and a good one goes with the run", async ({ page }) => {
  const id = await started(page, "[scene:usage] hello");
  await settled(service, id);
  const input = page.getByLabel("Attach files").first();
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
  await input.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: tooBig });
  await expect(page.getByRole("alert").filter({ hasText: "Images can be up to 10 MiB." })).toBeVisible();
  await box(page).fill("look at this");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry huge.png" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Images can be up to 10 MiB." })).toBeVisible();
  await page.getByRole("button", { name: "Remove huge.png" }).click();
  await input.setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("note.txt");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await box(page).press("Enter");
  await expect(page.getByRole("list", { name: "Attachments" })).toBeHidden();
  await settled(service, id);
});

test("a queued message goes back to the composer, is removed, or waits held after a stop", async ({ page }) => {
  const id = await started(page, "[hang]");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await service.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${id}`)).active_run?.state).toBe("running");
  await box(page).fill("edit me");
  await box(page).press("Enter");
  await page.getByRole("button", { name: "Edit: edit me" }).click();
  await expect(box(page)).toHaveValue("edit me");
  await expect(page.getByLabel("Queued messages")).toBeHidden();

  await box(page).fill("remove me");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await page.getByRole("button", { name: "Remove: remove me" }).click();
  await expect(page.getByLabel("Queued messages")).toBeHidden();

  await box(page).fill("wait for me");
  await box(page).press("Enter");
  await expect(page.getByText("wait for me")).toBeVisible();
  await expect(box(page)).toHaveValue("");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Held after the last run stopped.")).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByText("Held after the last run stopped.")).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByLabel("Queued messages")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".msg-user").getByText("wait for me")).toBeVisible();
});

test("/compact comes from the menu and the context meter", async ({ page }) => {
  const id = await started(page, "[scene:usage] counted");
  await settled(service, id);
  await box(page).pressSequentially("/com");
  await expect(page.getByRole("option", { name: /compact/ })).toBeVisible();
  await box(page).fill("");
  await page.getByRole("button", { name: /^Context 60% used.*Compact the conversation$/ }).click();
  await expect(page.locator(".msg-user").getByText("/compact")).toBeVisible();
  await settled(service, id);
});

test("$ lists the library's skills, and they join the / menu by setting", async ({ page }) => {
  const id = await started(page, "[scene:usage] hello");
  await settled(service, id);
  await box(page).pressSequentially("$ho");
  await expect(page.getByRole("option", { name: /how/ })).toBeVisible();
  await page.getByRole("option", { name: /how/ }).click();
  await expect(box(page)).toHaveValue("$how ");
  await box(page).fill("");
  await box(page).pressSequentially("/ho");
  await expect(page.getByRole("listbox", { name: "Suggestions" })).toBeHidden();
  await box(page).fill("");
  await page.goto(`${service.page}#/settings/chat`);
  await page.getByRole("switch", { name: "Show skills in the slash menu" }).check();
  await page.goto(`${service.page}#/threads/${id}`);
  await box(page).pressSequentially("/ho");
  await expect(page.getByRole("option", { name: /how/ })).toBeVisible();
  await box(page).fill("");
});

test("a custom model joins the picker and can go again", async ({ page }) => {
  await page.goto(`${service.page}#/settings/providers`);
  const row = page.locator(".setting-list > li").filter({ hasText: "Codex" });
  await row.getByRole("button", { name: /^Models \(/ }).click();
  await row.getByLabel("Model id").fill("house-model");
  await row.getByLabel("Display name").fill("House Model");
  await row.getByRole("button", { name: "Add model" }).click();
  await expect(row.getByRole("button", { name: "Remove House Model" })).toBeVisible();
  const models = await service.api<{ models: { id: string; custom: boolean }[] }>("GET", "/api/engines/codex/models");
  expect(models.models.find((model) => model.id === "house-model")?.custom).toBe(true);
  await row.getByRole("button", { name: "Remove House Model" }).click();
  await expect(row.getByRole("button", { name: "Remove House Model" })).toBeHidden();
});
