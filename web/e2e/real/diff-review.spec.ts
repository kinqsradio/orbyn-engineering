import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDetails, send, settled, startProject, type Service } from "./service";

let service: Service;
let projectId = "";

const commit = (message: string) => {
  execFileSync("git", ["add", "."], { cwd: service.repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", message], { cwd: service.repo });
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
});
test.afterAll(async () => { await service?.stop(); });

const thread = (title: string) => service.api<{ id: string }>("POST", "/api/threads", {
  project_id: projectId, engine: "codex", model: null, title, worktree: null, skill_profile: null,
});

test("E10: a diff range comment shows inline, follows its chip and reaches the prompt", async ({ page }) => {
  writeFileSync(join(service.repo, "review.txt"), "alpha\nbravo\ncharlie\n");
  commit("Review base");
  writeFileSync(join(service.repo, "review.txt"), "alpha\nBRAVO\ncharlie\n");
  const { id } = await thread("Diff review");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${id}`);
  await (await openDetails(page)).getByRole("button", { name: /^Changes/ }).click();
  const file = page.locator("[data-diff-file='review.txt']");
  await file.getByRole("button", { name: "Comment on line 1", exact: true }).click();
  await file.getByRole("button", { name: "Comment on line 2", exact: true }).click({ modifiers: ["Shift"] });
  await file.getByLabel("Review comment on review.txt line 1–2").fill("Why uppercase?");
  await file.getByRole("button", { name: "Add to message" }).click();

  const note = file.getByRole("note", { name: "Review comment review.txt:1–2" });
  await expect(note).toContainText("Why uppercase?");
  const chip = page.getByRole("button", { name: "Review comment review.txt:1–2", exact: true });
  await expect(chip).toBeVisible();
  // Editing the chip edits the annotation: there is one comment, not two.
  await chip.click();
  const details = page.getByRole("dialog", { name: "Review comment review.txt:1–2", exact: true });
  await expect(details.locator("pre")).toHaveText("alpha\nBRAVO");
  await details.getByRole("textbox", { name: "Review comment", exact: true }).fill("Keep it lowercase");
  await details.getByRole("button", { name: "Save comment" }).click();
  await expect(note).toContainText("Keep it lowercase");

  // Removing the annotation removes the chip.
  await note.getByRole("button", { name: "Remove comment" }).click();
  await expect(chip).toHaveCount(0);

  await file.getByRole("button", { name: "Comment on line 2", exact: true }).click();
  await file.getByLabel("Review comment on review.txt line 2").fill("Sent from the diff");
  await file.getByRole("button", { name: "Add to message" }).click();
  await send(page, "look at my comment");
  await settled(service, id);
  const messages = JSON.stringify(await service.api("GET", `/api/threads/${id}/messages?limit=10`));
  expect(messages).toContain("Review on `review.txt:2`");
  expect(messages).toContain("Sent from the diff");
  expect(messages).toContain("BRAVO");
  await expect(file.getByRole("note", { name: /Review comment/ })).toHaveCount(0);
});

test("E18: a large uncommitted diff loads files as you scroll, and find covers loaded files only", async ({ page }) => {
  const dir = join(service.repo, "bulk");
  mkdirSync(dir, { recursive: true });
  for (let at = 0; at < 130; at += 1) writeFileSync(join(dir, `file-${String(at).padStart(3, "0")}.txt`), `marker ${at}\n`);
  const { id } = await thread("Large diff");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${id}`);
  await (await openDetails(page)).getByRole("button", { name: /^Changes/ }).click();
  const files = page.locator("[data-diff-file^='bulk/']");
  await expect(files.first()).toBeVisible();
  const first = await files.count();
  expect(first).toBeLessThan(130);
  await page.getByRole("searchbox", { name: "Find in diff" }).fill("marker");
  await expect(page.getByText(/Find covers the \d+ of 13\d files loaded so far/)).toBeVisible();
  // Scrolling to the end of the list loads the rest, page by page.
  for (let round = 0; round < 10 && (await files.count()) < 130; round += 1) {
    await page.locator(".diff-more").scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }
  await expect(files).toHaveCount(130);
  await expect(page.getByText(/Find covers/)).toHaveCount(0);
  await expect(page.locator(".diff-find output")).toHaveText(/^1[3-9]\d matches$/);
});
