import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** The composer's own behaviour against the real service. */
const PORT = 5280;

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject(PORT, { scenes: true }));
});
test.afterAll(() => service.stop());

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });

async function newThread(page: Page, prompt = "[scene:usage] hello") {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  await expect(page.locator(".msg-assistant").first()).toBeVisible();
  return id;
}

test("sent prompts recall with the arrows, and the context meter reads the engine's usage", async ({ page }) => {
  await newThread(page);
  await expect(page.getByRole("img", { name: /^Context 60% used/ })).toBeVisible();
  await box(page).press("ArrowUp");
  await expect(box(page)).toHaveValue("[scene:usage] hello");
  await box(page).press("ArrowDown");
  await expect(box(page)).toHaveValue("");
});

test("send shortcut modes follow the setting", async ({ page }) => {
  await newThread(page);
  await page.goto(`${service.page}#/settings/chat`);
  await page.getByRole("combobox", { name: "Send shortcut" }).selectOption("mod-enter");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
  await expect(box(page)).toBeFocused();
  await box(page).fill("one");
  await box(page).press("Enter");
  await expect(box(page)).not.toHaveValue("");
  await box(page).press("ControlOrMeta+Enter");
  await expect(box(page)).toHaveValue("");
  await page.goto(`${service.page}#/settings/chat`);
  await page.getByRole("combobox", { name: "Send shortcut" }).selectOption("enter");
});

test("Plan switches with the button and /plan, and /usage-limits answers inline", async ({ page }) => {
  const id = await newThread(page);
  const plan = page.getByRole("button", { name: "Plan", exact: true });
  await plan.click();
  await expect(plan).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await service.api<{ lifecycle: { plan_mode: boolean } }>("GET", `/api/threads/${id}`)).lifecycle.plan_mode)
    .toBe(true);
  await send(page, "/default");
  await expect(plan).toHaveAttribute("aria-pressed", "false");
  await send(page, "/plan");
  await expect(plan).toHaveAttribute("aria-pressed", "true");
  await send(page, "/default");

  await send(page, "/usage-limits");
  const limits = page.getByRole("region", { name: "Usage limits" });
  await expect(limits).toContainText("% used");
  await limits.getByRole("button", { name: "Close usage limits" }).click();
  await expect(limits).toBeHidden();
});

test("stash saves and restores a draft", async ({ page }) => {
  await newThread(page);
  await box(page).fill("keep this for later");
  await box(page).press("ControlOrMeta+s");
  await expect(box(page)).toHaveValue("");
  await box(page).fill("and this");
  await box(page).press("ControlOrMeta+s");
  await page.getByRole("button", { name: "2 stashed prompts" }).click();
  await page.getByRole("region", { name: "Stashed prompts" }).getByRole("button", { name: "keep this for later" }).click();
  await expect(box(page)).toHaveValue("keep this for later");
  await box(page).fill("");
  await box(page).press("ControlOrMeta+s");
  await expect(box(page)).toHaveValue("and this");
});

test("large pastes attach, images drop in, and lists continue", async ({ page }) => {
  await newThread(page);
  await box(page).focus();
  const large = "x".repeat(33 * 1024);
  await box(page).evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, large);
  const strip = page.getByRole("list", { name: "Attachments" });
  await expect(strip).toContainText("pasted-text.txt");
  await expect(box(page)).toHaveValue("");

  await page.locator(".composer-box").evaluate((element) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    data.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(strip.locator("img.attachment-thumb")).toBeVisible();

  await box(page).fill("- first");
  await box(page).press("End");
  await box(page).press("Shift+Enter");
  await expect(box(page)).toHaveValue("- first\n- ");
  await box(page).press("Tab");
  await expect(box(page)).toHaveValue("- first\n  - ");
});

test("a follow-up steers or queues by setting, and the opposite key flips it", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[hang]");
  await expect(page).toHaveURL(/#\/threads\//);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
  const id = threadIdOf(page);
  await expect
    .poll(async () => (await service.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${id}`)).active_run?.state)
    .toBe("running");
  await box(page).fill("queued one");
  await box(page).press("Enter");
  await expect(page.getByText("queued one")).toBeVisible();
  await box(page).fill("steered now");
  await box(page).press("ControlOrMeta+Enter");
  await expect(page.locator(".msg-assistant").getByText("steered: steered now")).toBeVisible({ timeout: 15_000 });
});

test("keyboard rules come from the service: terminal, details, palette, next thread, pin", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const first = await newThread(page);
  const second = await newThread(page);
  await page.locator("body").click({ position: { x: 700, y: 300 } });
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByRole("region", { name: "Terminal" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+j");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog").getByRole("combobox").or(page.getByRole("dialog").getByRole("textbox")).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
  await expect.poll(() => page.url()).toContain(first);
  await expect(box(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect
    .poll(async () => (await service.api<{ lifecycle: { pinned_at: string | null } }>("GET", `/api/threads/${threadIdOf(page)}`)).lifecycle.pinned_at)
    .not.toBeNull();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.goto(`${service.page}#/threads/${second}`);
  await expect(box(page)).toBeVisible();
  await page.locator("body").click({ position: { x: 700, y: 300 } });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByRole("textbox", { name: "Find in thread" })).toBeVisible();
});
