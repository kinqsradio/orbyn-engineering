import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startProject, type Service } from "./service";

/** The usage page over a synthetic history, and limits from the protocol double. */
const PORT = 5289;

let service: Service;
let projectId = "";

const history = (model: string) =>
  `${JSON.stringify({
    timestamp: new Date().toISOString(),
    message: { id: `m-${model}`, model, usage: { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })}\n`;

test.beforeAll(async () => {
  ({ service, projectId } = await startProject(PORT, { fakeEngines: true }));
  const folder = join(service.dataDir, "../claude/projects/p");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "s.jsonl"), history("house-model") + history("other-model"));
});
test.afterAll(() => service.stop());

test("a model takes a price, follows another model and refreshes; keys move the page", async ({ page }) => {
  await page.goto(`${service.page}#/usage`);
  const usage = page.getByRole("dialog", { name: "Usage" });
  await usage.getByRole("button", { name: "Refresh usage" }).click();
  await usage.getByRole("button", { name: "Set price for house-model" }).click();
  const dialog = page.getByRole("dialog", { name: "Price for house-model" });
  await dialog.getByLabel("Input", { exact: true }).fill("2");
  await dialog.getByLabel("Output").fill("10");
  await dialog.getByLabel("Cached input").fill("0");
  await dialog.getByLabel("Cache write").fill("0");
  await dialog.getByRole("button", { name: "Save price" }).click();
  await expect(dialog).toBeHidden();
  await page.keyboard.press("c");
  await expect(usage.getByRole("radio", { name: "Cost" })).toBeChecked();
  await expect(usage.getByRole("row", { name: /house-model/ })).toContainText("$7");
  await expect(usage.getByRole("row", { name: /other-model/ })).toContainText("Unpriced");

  await usage.getByRole("button", { name: "Set price for other-model" }).click();
  const alias = page.getByRole("dialog", { name: "Price for other-model" });
  await alias.getByLabel("Counts as").fill("house-model");
  await alias.getByRole("button", { name: "Save price" }).click();
  await expect(alias).toBeHidden();
  await expect(usage.getByText("Unpriced")).toBeHidden();

  await page.keyboard.press("t");
  await expect(usage.getByRole("radio", { name: "Tokens" })).toBeChecked();
  await page.keyboard.press("2");
  await expect(usage.getByRole("radio", { name: "7 days" })).toBeChecked();
  await page.keyboard.press("4");
  await expect(usage.getByRole("radio", { name: "90 days" })).toBeChecked();
  await page.keyboard.press("l");
  await expect(usage.getByRole("radio", { name: "Limits" })).toBeChecked();
  await expect(usage.getByRole("heading", { name: "Pooled" })).toBeVisible();
  await expect(usage.locator(".limit-reset").first()).toBeVisible();
  await expect(usage.locator(".usage-plan").first()).toBeVisible();
});

test("thread details show what's left, and checks stay five minutes apart", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const engine = engines.find((entry) => entry.id === "codex")?.id;
  const create = (title: string) =>
    service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine, title, model: null, worktree: null, skill_profile: null });
  const first = await create("One");
  await create("Two");
  let checks = 0;
  page.on("request", (request) => {
    if (/\/api\/threads\/[^/]+\/limits/.test(request.url())) checks += 1;
  });
  await page.goto(`${service.page}#/threads/${first.id}`);
  await expect(page.getByText(/% left/)).toBeVisible();
  await page.locator("li[data-thread-item]").filter({ hasText: "Two" }).click();
  await expect(page.getByRole("heading", { name: "Two" })).toBeVisible();
  await expect(page.getByText(/% left/)).toBeVisible();
  expect(checks).toBe(1);
});
