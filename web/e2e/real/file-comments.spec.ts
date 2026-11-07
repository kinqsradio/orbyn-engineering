import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { send, settled, startProject, type Service } from "./service";

let service: Service;
let projectId: string;
test.beforeAll(async () => { ({ service, projectId } = await startProject({ fakeEngines: true })); });
test.afterAll(async () => { await service?.stop(); });

test("file ranges become editable review chips and reach the persisted prompt", async ({ page }) => {
  const original = "first line\n<script>captured text</script>\nlast line\n";
  const file = join(service.repo, "review-source.txt");
  writeFileSync(file, original);
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId, engine: "codex", model: null, title: "File review", worktree: null, skill_profile: null,
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search" }).fill("review-source.txt");
  await palette.getByRole("button", { name: /review-source\.txt/ }).first().click();
  const viewer = page.locator(".files-viewer");
  await viewer.getByRole("button", { name: "Comment on line 3", exact: true }).click();
  await viewer.getByRole("button", { name: "Comment on line 1", exact: true }).click({ modifiers: ["Shift"] });
  await viewer.getByRole("textbox", { name: "File comment" }).fill("Please check this range");
  await viewer.getByRole("button", { name: "Add comment", exact: true }).click();
  const chip = page.getByRole("button", { name: "Review comment review-source.txt:1–3", exact: true });
  await chip.click();
  const details = page.getByRole("dialog", { name: "Review comment review-source.txt:1–3", exact: true });
  await expect(details.locator("pre")).toHaveText(original.trimEnd());
  await details.getByRole("textbox", { name: "Review comment", exact: true }).fill("Edited review comment");
  await details.getByRole("button", { name: "Save comment" }).click();
  await expect(viewer.getByRole("list", { name: "File comments" })).toContainText("Edited review comment");
  await chip.click();
  await details.getByRole("button", { name: "Remove comment" }).click();
  await expect(chip).toHaveCount(0);
  await viewer.getByRole("button", { name: "Comment on line 2", exact: true }).click();
  await viewer.getByRole("textbox", { name: "File comment" }).fill("Captured source stays readable");
  await viewer.getByRole("button", { name: "Add comment", exact: true }).click();
  await page.getByRole("button", { name: "Review comment review-source.txt:2", exact: true }).click();
  const finalDetails = page.getByRole("dialog", { name: "Review comment review-source.txt:2", exact: true });
  await finalDetails.getByRole("textbox", { name: "Review comment", exact: true }).fill("Review saved after resize");
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(finalDetails.getByRole("button", { name: "Save comment" })).toBeVisible();
  await expect(finalDetails.getByRole("textbox", { name: "Review comment", exact: true })).toHaveValue("Review saved after resize");
  await page.screenshot({ path: test.info().outputPath("review-comment-narrow.png") });
  await finalDetails.getByRole("button", { name: "Save comment" }).click();
  await expect(finalDetails).toBeHidden();
  await expect(page.getByRole("button", { name: "Review comment review-source.txt:2", exact: true })).toBeFocused();
  for (const close of ["Cancel", "Escape"]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Review comment review-source.txt:2", exact: true }).click();
    await expect(finalDetails.getByRole("textbox", { name: "Review comment", exact: true })).toHaveValue("Review saved after resize");
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(finalDetails).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else await finalDetails.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(finalDetails).toBeHidden();
    await expect(page.getByRole("button", { name: "Review comment review-source.txt:2", exact: true })).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Editing the file after attachment must not replace the captured prompt context.
  writeFileSync(file, "later disk version\n");
  await send(page, "explain this comment");
  await settled(service, thread.id);
  const messages = JSON.stringify(await service.api("GET", `/api/threads/${thread.id}/messages?limit=10`));
  expect(messages).toContain("Review on `review-source.txt:2`");
  expect(messages).toContain("Review saved after resize");
  expect(messages).toContain("<script>captured text</script>");
  expect(messages).not.toContain("later disk version");
  expect(readFileSync(file, "utf8")).toBe("later disk version\n");
  await expect(page.getByRole("list", { name: "Context chips" })).toHaveCount(0);
});
