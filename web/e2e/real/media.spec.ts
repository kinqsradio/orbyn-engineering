import { expect, test } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Media in a message, through the real service and the thread's own checkout. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("media loads from the checkout, pages in one dialog, and saves", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:media] hello");
  await expect(page).toHaveURL(/#\/threads\//);
  await settled(service, threadIdOf(page));

  const first = page.getByRole("button", { name: "Expand first" });
  const second = page.getByRole("button", { name: "Expand second" });
  await expect(first.locator("img")).toHaveAttribute("src", /\/files\/raw\?path=shot-a\.svg(&token=\w+)?$/);
  await expect(second.locator("img")).toHaveAttribute("src", /\/files\/raw\?path=shot-b\.svg(&token=\w+)?$/);
  // The service refuses a path outside the checkout, so the missing one reads as a sentence.
  await expect(page.getByText("Image unavailable · third")).toBeVisible();
  await expect(page.locator(".md")).not.toContainText("![first]");

  await first.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("1 of 2")).toBeVisible();
  await expect(dialog.locator("img")).toHaveAttribute("src", /path=shot-a\.svg&token=\w+$/);

  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByText("2 of 2")).toBeVisible();
  await expect(dialog.locator("img")).toHaveAttribute("src", /path=shot-b\.svg&token=\w+$/);
  await dialog.getByRole("button", { name: "Previous" }).click();
  await expect(dialog.getByText("1 of 2")).toBeVisible();

  // Save goes through the download route for a checkout file, which is the same origin.
  const save = dialog.getByRole("link", { name: "Save" });
  await expect(save).toHaveAttribute("href", /path=shot-a\.svg.*download=true/);
  await expect(save).toHaveAttribute("download", "shot-a.svg");
  await expect(dialog.getByRole("button", { name: "Copy path" })).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});