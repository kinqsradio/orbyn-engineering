import { expect, test } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** What a sent message carried stays readable and reachable after the turn. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true, forge: true }));
});
test.afterAll(() => service.stop());

test("sent files and typed paths stay as chips that still open", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("sent context\n"),
  });
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("notes.txt");

  await send(page, "read @README.md with the notes");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);

  const chips = page.getByRole("list", { name: "Sent with this message" });
  await expect(chips.getByRole("button", { name: "Open notes.txt" })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Show README.md" })).toBeVisible();

  await chips.getByRole("button", { name: "Open notes.txt" }).click();
  const preview = page.getByRole("dialog", { name: "notes.txt" });
  await expect(preview.getByText("sent context")).toBeVisible();
  await preview.getByRole("button", { name: "Close" }).click();
  await expect(preview).toBeHidden();

  await chips.getByRole("button", { name: "Show README.md" }).click();
  const viewer = page.locator(".files-viewer");
  await expect(viewer.locator("code")).toHaveText("README.md");
  await expect(viewer.getByRole("heading", { name: "Repo" })).toBeVisible();
});
