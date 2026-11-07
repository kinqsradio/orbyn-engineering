import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { openPanelTab, send, settled, startProject, threadIdOf, type Service } from "./service";

/**
 * B40: a review comment on a diff line, the file a reply revealed at its line, a
 * terminal selection and a picked page element each become a chip, and all of
 * them reach the real service as labelled prompt blocks.
 */

let service: Service;
let projectId = "";
let threadId = "";
let site: Server;
let sitePort = 0;

test.beforeAll(async () => {
  site = createServer((_, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end('<body style="margin:0"><button id="target" style="width:100vw;height:100vh">Pick me</button></body>');
  }).listen(0, "127.0.0.1");
  await once(site, "listening");
  sitePort = (site.address() as AddressInfo).port;
  ({ service, projectId } = await startProject({ scenes: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: service.repo, stdio: "ignore" });
  writeFileSync(join(service.repo, "notes.txt"), "one\ntwo\nthree\nfour\n");
  git("add", "notes.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Notes");
  writeFileSync(join(service.repo, "notes.txt"), "one\ntwo changed\nthree\nfour\n");
});
test.afterAll(async () => {
  // End the browsers before the service exits, so Windows can release their profiles.
  if (threadId) {
    const base = `/api/threads/${threadId}/previews`;
    for (const tab of await service.api<{ id: string }[]>("GET", base)) {
      await service.api("DELETE", `${base}/${tab.id}`);
      await expect.poll(() => existsSync(join(service.dataDir, "preview-profiles", tab.id))).toBe(false);
    }
  }
  await service.stop();
  site.close();
});

const chips = (page: Page) => page.getByRole("list", { name: "Context chips", exact: true });

/** Types until the shell answers, since a shell still starting can lose what is typed. */
async function run(page: Page, command: string, output: RegExp): Promise<Locator> {
  const input = page.locator(".terminal-drawer-body .xterm-helper-textarea").first();
  const line = page.locator(".terminal-drawer-body .xterm-rows > div").filter({ hasText: output }).first();
  await expect(async () => {
    await input.focus();
    await page.keyboard.type(command);
    await expect(line).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 25_000 });
  return line;
}

test("diff, file, terminal and page-element chips are sent as labelled blocks", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:file-link] where is line three");
  await expect(page).toHaveURL(/#\/threads\//);
  threadId = threadIdOf(page);
  await settled(service, threadId);

  // Review comment: both diff layouts offer one on the new side of a line; this one is made in split.
  await openPanelTab(page, "Diff");
  const patch = page.locator("[data-diff-file='notes.txt']");
  await expect(patch.locator(".patch-line").first()).toBeVisible();
  await expect(patch.getByRole("button", { name: "Comment on line 2", exact: true })).toBeAttached();
  const view = page.getByRole("radiogroup", { name: "Diff view" });
  await view.getByRole("radio", { name: "Split" }).click();
  await expect(patch.locator(".patch-split").first()).toBeVisible();
  await patch.locator(".patch-split", { hasText: "two changed" }).getByRole("button", { name: "Comment on line 2", exact: true }).click();
  await page.getByRole("textbox", { name: "Review comment on notes.txt line 2" }).fill("Why change two?");
  await page.getByRole("button", { name: "Add to message", exact: true }).click();
  await view.getByRole("radio", { name: "Unified" }).click();
  await expect(chips(page).locator("li[data-kind=review]")).toContainText("notes.txt:2");

  // File: the link in the reply reveals line 3, and the open file joins the message there.
  await page.locator(".msg-assistant").getByRole("button", { name: "the notes" }).click();
  const viewer = page.locator(".files-viewer");
  await expect(viewer.getByText("notes.txt", { exact: true })).toBeVisible();
  await viewer.getByRole("button", { name: "Add file to message" }).click();
  await expect(chips(page).locator("li[data-kind=file]")).toContainText("notes.txt:3");

  // Terminal: a selection in the drawer.
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const line = await run(page, "echo CHIP_SOURCE_SENTINEL\n", /^CHIP_SOURCE_SENTINEL\s*$/);
  const place = await line.boundingBox();
  if (!place) throw new Error("no terminal line");
  await page.mouse.dblclick(place.x + 6, place.y + place.height / 2);
  await page.getByRole("button", { name: "Add selection", exact: true }).click();
  await expect(chips(page).locator("li[data-kind=terminal]")).toHaveCount(1);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();

  // Page element: picked from the service's own browser.
  await page.getByRole("tab", { name: "Browser", exact: true }).click();
  const address = page.getByRole("combobox", { name: "Search or enter URL" });
  await address.fill(`127.0.0.1:${sitePort}/pick`);
  await address.press("Enter");
  const frame = page.getByRole("img", { name: /^Page at/ });
  await expect(frame).toBeVisible({ timeout: 40_000 });
  await page.getByRole("button", { name: "Pick an element" }).click();
  await frame.click();
  await expect(chips(page).locator("li[data-kind=annotation]")).toContainText("target");

  await expect(chips(page).locator("li[data-kind]")).toHaveCount(4);
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill("Review all of it");
  const request = page.waitForRequest((sent) => sent.method() === "POST" && sent.url().endsWith(`/api/threads/${threadId}/runs`));
  await box.press("Enter");
  const { prompt } = (await request).postDataJSON() as { prompt: string };
  const blocks = prompt.split("\n\n");
  expect(blocks[0]).toBe("Review on `notes.txt:2`\nWhy change two?\n```\ntwo changed\n```");
  expect(blocks[1]).toMatch(/^File `notes\.txt:3`\n```\none\ntwo changed\nthree\nfour\n?```$/);
  expect(blocks[2]).toMatch(/^Terminal selection line \d+\n```\nCHIP_SOURCE_SENTINEL\n```$/);
  expect(blocks[3]).toMatch(new RegExp(`^Element \`[^\`]*target[^\`]*\` on http://127\\.0\\.0\\.1:${sitePort}/pick`));
  expect(blocks.at(-1)).toBe("Review all of it");
  await settled(service, threadId);
  await expect(chips(page)).toHaveCount(0);
});
