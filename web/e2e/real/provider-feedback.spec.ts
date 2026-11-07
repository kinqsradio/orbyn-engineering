import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProject, type Service } from "./service";

// Real HTTP and pipes, with an explicit protocol double. No provider submission.
let service: Service;
let root: string;
let launch: string;
type Launch = { mode: string; args: string[] };
function records(): Launch[] {
  return existsSync(launch)
    ? readFileSync(launch, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Launch)
    : [];
}
const uploads = () => records().filter((entry) => entry.mode === "codex-feedback");
const feedbackResponse = (page: Page) => page.waitForResponse((response) =>
  response.request().method() === "POST" && new URL(response.url()).pathname === "/api/engines/codex/feedback");

async function openFeedback(page: Page) {
  await page.goto(`${service.page}#/settings/providers`);
  await page.getByRole("table", { name: "Providers" }).getByRole("button", { name: "Codex", exact: true }).click();
  await page.getByRole("button", { name: "Send feedback", exact: true }).click();
  return page.getByRole("dialog", { name: "Send feedback to Codex?", exact: true });
}

test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "orbyn-feedback-"));
  launch = join(root, "launches");
  ({ service } = await startProject({ fakeEngines: true, engineLaunchLog: launch }));
});
test.afterEach(async () => {
  try { await service?.stop(); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancel sends nothing; explicit send preserves the default privacy choice and shows the real receipt", async ({ page }) => {
  let dialog = await openFeedback(page);
  await expect(dialog.getByText(/goes to OpenAI through Codex/)).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "Include Codex logs" })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(uploads()).toEqual([]);
  await page.getByRole("button", { name: "Send feedback", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Send feedback to Codex?", exact: true });
  await dialog.getByLabel("What went wrong? (optional)").fill("  synthetic report  ");
  const reply = feedbackResponse(page);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  const response = await reply;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ thread_id: "fake-feedback-1" });
  await expect(page.getByRole("status").filter({ hasText: "Report fake-feedback-1" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(uploads()).toHaveLength(1);
  expect(JSON.parse(uploads()[0]!.args[0]!)).toEqual({ classification: "bug", includeLogs: false, reason: "synthetic report" });
  expect(records().some((entry) => entry.mode === "codex-thread" || entry.mode === "codex-turn")).toBe(false);
});

test("a protocol failure reaches the dialog and an explicit retry preserves the draft and recovers", async ({ page }) => {
  const marker = join(root, "feedback-error");
  writeFileSync(marker, "");
  const dialog = await openFeedback(page);
  const reason = dialog.getByLabel("What went wrong? (optional)");
  await reason.fill("synthetic retry report");
  const failed = feedbackResponse(page);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  const response = await failed;
  expect(response.status()).toBe(502);
  expect(await response.json()).toMatchObject({ code: "engine_unavailable" });
  await expect(dialog.getByRole("alert")).toContainText("Synthetic feedback failure.");
  await expect(reason).toHaveValue("synthetic retry report");
  await expect(dialog.getByRole("button", { name: "Send feedback", exact: true })).toBeEnabled();
  expect(uploads()).toHaveLength(1);
  unlinkSync(marker);
  const recovered = feedbackResponse(page);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  expect((await recovered).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "Report fake-feedback-1" })).toBeVisible();
  expect(uploads()).toHaveLength(2);
  expect(uploads().map((entry) => JSON.parse(entry.args[0]!))).toEqual([
    { classification: "bug", includeLogs: false, reason: "synthetic retry report" },
    { classification: "bug", includeLogs: false, reason: "synthetic retry report" },
  ]);
});

test("logs are attached only after explicit opt-in through the real service", async ({ page }) => {
  const dialog = await openFeedback(page);
  await dialog.getByRole("switch", { name: "Include Codex logs" }).check();
  await expect(dialog.getByText(/can include prompts, file paths and command output/)).toBeVisible();
  const reply = feedbackResponse(page);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  expect((await reply).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "Report fake-feedback-1" })).toBeVisible();
  expect(uploads()).toHaveLength(1);
  expect(JSON.parse(uploads()[0]!.args[0]!)).toEqual({ classification: "bug", includeLogs: true });
});
