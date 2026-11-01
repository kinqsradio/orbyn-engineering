import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** The thread's surroundings: details rows, relations, new messages, the Working shelf. */

interface Listed {
  id: string;
  title: string;
  lifecycle: { relation: string | null; parent_thread_id: string | null; visited_at?: string };
}

let service: Service;
let projectId = "";


const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const details = (page: Page) => page.getByRole("complementary", { name: "Thread details" });
const row = (page: Page, id: string) => page.locator(`li[data-thread-item="${id}"]`);
const fresh = async (page: Page, prompt: string) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/#\/threads\//);
  return threadIdOf(page);
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true, forge: true }));

});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1500, height: 900 }));

test("details shows linked pull requests, and right-click turns rows off and back", async ({ page }) => {
  const id = await fresh(page, "[scene:usage] hello");
  await settled(service, id);
  await service.api("POST", `/api/threads/${id}/pulls`, { number: 42 });
  await page.reload();
  await expect(details(page).getByRole("button", { name: /Fix the login/ })).toBeVisible();
  await details(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pull requests" }).click();
  await expect(details(page).getByRole("button", { name: /Fix the login/ })).toBeHidden();
  await details(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Usage" }).click();
  await expect(details(page).getByText("Usage")).toBeVisible();
  await details(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reset" }).click();
  await expect(details(page).getByRole("button", { name: /Fix the login/ })).toBeVisible();
  await page.goto(`${service.page}#/settings/general`);
  await expect(page.getByRole("button", { name: "7 of 8 on" })).toBeVisible();
});

test("Related threads lists the parent and its forks", async ({ page }) => {
  const id = await fresh(page, "[scene:usage] root");
  await settled(service, id);
  const fork = await service.api<Listed>("POST", `/api/threads/${id}/fork`, { title: "The fork" });
  await page.reload();
  await page.getByRole("button", { name: "Related threads" }).click();
  await page.getByRole("menuitem", { name: /Fork: The fork/ }).click();
  await expect(page).toHaveURL(new RegExp(fork.id));
  await page.getByRole("button", { name: "Related threads" }).click();
  await expect(page.getByRole("menuitem", { name: /Parent:/ })).toBeVisible();
});

test("a thread you left shows where the new messages start", async ({ page }) => {
  const id = await fresh(page, "one");
  await settled(service, id);
  await expect(page.getByText("hello from codex")).toBeVisible();
  await page.getByRole("link", { name: "New thread", exact: true }).click();
  await expect(page).not.toHaveURL(/#\/threads\//);
  await page.waitForTimeout(1100);
  await service.api("POST", `/api/threads/${id}/runs`, { prompt: "two" });
  await settled(service, id);
  await page.goto(`${service.page}#/threads/${id}`);
  await expect(page.getByText("New since you were here")).toBeVisible();
  // Your own message in the same visit doesn't move it, and the next visit clears it.
  await send(page, "three");
  await settled(service, id);
  await expect(page.getByText("New since you were here")).toHaveCount(1);
  // The mark after the reply has gone, so the next one is the mark for leaving.
  await page.waitForTimeout(800);
  const left = page.waitForResponse((response) => response.request().method() === "PATCH");
  await page.getByRole("link", { name: "New thread", exact: true }).click();
  await left;
  await page.goto(`${service.page}#/threads/${id}`);
  await expect(box(page)).toBeVisible();
  await expect(page.getByText("New since you were here")).toHaveCount(0);
});

test("a watched thread goes to the Working shelf, unless that is off", async ({ page }) => {
  const id = await fresh(page, "[scene:usage] watch");
  await settled(service, id);
  await service.api("POST", `/api/threads/${id}/pulls`, { number: 77 });
  await service.api("POST", `/api/threads/${id}/pulls/77/watch`, {});
  await page.goto(`${service.page}#/new/${projectId}`);
  await expect(row(page, id)).toHaveAttribute("data-section", "working");
  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("dialog", { name: "Settings" }).getByRole("switch", { name: "Working section" }).click();
  await page.goto(`${service.page}#/new/${projectId}`);
  await expect(row(page, id)).toHaveAttribute("data-section", "active");
});

test("user messages keep same-thread editing and assistant responses keep forks", async ({ page }) => {
  const id = await fresh(page, "[scene:usage] first");
  await settled(service, id);
  await page.locator(".msg-user").last().hover();
  await expect(page.getByRole("button", { name: "Edit in a new thread" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit from here" }).last()).toBeEnabled();
  await expect(page.getByRole("button", { name: "Fork from this response" }).last()).toBeEnabled();
  await page.getByRole("button", { name: "Edit from here" }).last().click();
  await expect(page.getByRole("dialog", { name: "Edit from here?" })).toBeVisible();
  await page.getByRole("dialog", { name: "Edit from here?" }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(id));
  await expect(page.locator(".msg-user")).toHaveCount(1);
});

test("a pull request link opens in the panel, and its menu offers the host", async ({ page }) => {
  const id = await fresh(page, "[scene:pull-link] go");
  await settled(service, id);
  const link = page.getByRole("link", { name: "the pull request" });
  await link.click();
  await expect(page.getByRole("tab", { name: "Pull requests" })).toBeVisible();
  await expect(page.getByRole("tabpanel").getByText("Fix the login").first()).toBeVisible();
  await link.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open on the host" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
});
