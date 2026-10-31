import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** The chat, the panels and the sidebar scroll on their own. */

let service: Service;
let projectId = "";

const chat = (page: Page) => page.getByRole("log", { name: "Thread messages" });
const chatTop = (page: Page) => chat(page).evaluate((element) => element.scrollTop);
const mainTop = (page: Page) => page.locator("main").first().evaluate((element) => element.scrollTop);
const gap = (page: Page) =>
  chat(page).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);

/** Wheels over a target to both ends and past them, as a trackpad overscroll would. */
async function wheelBothEnds(page: Page, target: Locator) {
  await target.hover();
  for (const delta of [4000, 4000, 4000, -4000, -4000, -4000, 4000, 4000]) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(60);
  }
}

async function expectChatUntouched(page: Page, target: Locator) {
  const before = await chatTop(page);
  await wheelBothEnds(page, target);
  expect(await chatTop(page)).toBe(before);
  expect(await mainTop(page)).toBe(0);
}

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
  const lines = Array.from({ length: 400 }, (_, at) => `line ${at}`).join("\n");
  writeFileSync(join(service.repo, "big.txt"), `${lines}\n`);
  execFileSync("git", ["add", "."], { cwd: service.repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "Big"], { cwd: service.repo });
  writeFileSync(join(service.repo, "big.txt"), `${lines.replaceAll("line", "changed")}\n`);
});
test.afterAll(() => service.stop());

async function longThread(page: Page, scene = "[scene:long]") {
  await page.setViewportSize({ width: 1500, height: 520 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, scene);
  await expect(page).toHaveURL(/#\/threads\//);
}

test("each panel scrolls alone, past both ends, with the chat parked mid-way", async ({ page }) => {
  await longThread(page);
  await settled(service, threadIdOf(page));
  await expect(page.getByText("Paragraph 120 of a long answer.")).toBeVisible();
  await chat(page).evaluate((element) => {
    element.scrollTop = 600;
  });
  await page.waitForTimeout(100);

  const parked = await chatTop(page);
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.locator("[data-diff-file='big.txt']").waitFor();
  expect(await chatTop(page)).toBe(parked);
  await expectChatUntouched(page, page.locator(".patch-line").nth(20));
  const pane = page.getByRole("tabpanel");
  expect(await pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox", { name: "Search" }).fill("big.txt");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("button", { name: /big\.txt/ }).click();
  await expectChatUntouched(page, page.locator(".file-source"));

});

test("images, binaries and oversized text open from the raw route", async ({ page }) => {
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  writeFileSync(join(service.repo, "pixel.png"), Buffer.from(pixel, "base64"));
  writeFileSync(join(service.repo, "blob.bin"), Buffer.from([0, 1, 2, 0x41, 0x42, 0xff]));
  writeFileSync(join(service.repo, "huge.log"), `start of the log\n${"x".repeat(5_000_000)}`);
  await longThread(page);
  await settled(service, threadIdOf(page));
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const open = async (name: string) => {
    await page.keyboard.press("ControlOrMeta+p");
    await palette.getByRole("combobox", { name: "Search" }).fill(name);
    await palette.getByRole("button", { name: new RegExp(name.replace(".", "\\.")) }).first().click();
  };

  await open("pixel.png");
  const image = page.getByRole("img", { name: "pixel.png" });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  await expect(page.getByRole("link", { name: "Save file" })).toHaveAttribute("href", /download=true/);

  await page.getByRole("button", { name: "Files", exact: true }).click();
  await open("blob.bin");
  await expect(page.getByLabel("Bytes")).toContainText("00 01 02 41 42 ff");
  await expect(page.getByLabel("Bytes")).toContainText("...AB.");

  await page.getByRole("button", { name: "Files", exact: true }).click();
  await open("huge.log");
  await expect(page.getByLabel("Text", { exact: true })).toContainText("start of the log");
  await expect(page.getByText(/Showing 65,536 of 5,000,017 bytes/)).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(/Showing 131,072 of/)).toBeVisible();
});

test("one file of a turn goes back to how the turn found it", async ({ page }) => {
  const notes = join(service.repo, "notes.txt");
  writeFileSync(notes, "as committed\n");
  execFileSync("git", ["add", "notes.txt"], { cwd: service.repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "Notes"], { cwd: service.repo });
  await longThread(page, "[scene:edit]");
  await settled(service, threadIdOf(page));
  expect(readFileSync(notes, "utf8")).toBe("changed by the agent\n");

  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByRole("radiogroup", { name: "Diff source" }).getByRole("radio", { name: "Turn" }).click();
  await page.getByRole("button", { name: "Restore notes.txt to before this turn" }).click();
  await expect(page.getByText("notes.txt is back as it was before this turn")).toBeVisible();
  expect(readFileSync(notes, "utf8")).toBe("as committed\n");
});

test("the details card and terminal keep the wheel to themselves", async ({ page }) => {
  await longThread(page);
  await settled(service, threadIdOf(page));
  // A turn folds as it ends, which would move the position this test sets.
  await expect(async () => {
    const height = await chat(page).evaluate((element) => element.scrollHeight);
    await page.waitForTimeout(400);
    expect(await chat(page).evaluate((element) => element.scrollHeight)).toBe(height);
  }).toPass();
  await chat(page).evaluate((element) => {
    element.scrollTop = 600;
  });
  await expectChatUntouched(page, page.getByRole("complementary", { name: "Thread details" }));

  await page.keyboard.press("ControlOrMeta+j");
  const terminal = page.getByRole("region", { name: "Terminal" });
  await expect(terminal).toBeVisible();
  await page.waitForTimeout(300);
  const before = await chatTop(page);
  await wheelBothEnds(page, terminal);
  expect(await chatTop(page)).toBeLessThanOrEqual(before);
  expect(await mainTop(page)).toBe(0);
});

test("the Browser panel and the sidebar keep the wheel to themselves", async ({ page }) => {
  await longThread(page);
  await settled(service, threadIdOf(page));
  for (const at of Array.from({ length: 30 }, (_, index) => index)) {
    await service.api("POST", "/api/threads", {
      project_id: projectId,
      engine: (await service.api<{ id: string }[]>("GET", "/api/engines"))[0]?.id,
      model: null,
      title: `Filler ${at}`,
      worktree: null,
      skill_profile: null,
    });
  }
  await expect(page.locator("li[data-thread-item]").filter({ hasText: "Filler 29" })).toBeVisible({ timeout: 10_000 });
  await chat(page).evaluate((element) => {
    element.scrollTop = 600;
  });
  await expectChatUntouched(page, page.locator(".sidebar-scroll"));

  await page.getByRole("button", { name: "Surfaces" }).click();
  await page.locator(".launcher").getByRole("button", { name: /^Browser/ }).click();
  await expect(page.locator(".browser-panel")).toBeVisible();
  await expectChatUntouched(page, page.locator(".browser-panel"));
});

test("wheeling a panel during a run leaves the chat stuck to the bottom", async ({ page }) => {
  test.setTimeout(45_000);
  await longThread(page, "[scene:stream]");
  await expect(page.getByText("Streamed line 60.")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.locator(".patch-line").nth(20).waitFor();
  await wheelBothEnds(page, page.locator(".patch-line").nth(20));
  await expect(page.getByText("Tick 30.")).toBeAttached({ timeout: 15_000 });
  expect(await gap(page)).toBeLessThan(80);
  await settled(service, threadIdOf(page));
  await expect.poll(() => gap(page)).toBeLessThan(80);
  expect(await mainTop(page)).toBe(0);
});
