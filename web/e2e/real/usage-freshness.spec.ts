import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startService, type Service } from "./service";

let service: Service;
let historyFile: string;

function writeHistory(tokens: number) {
  writeFileSync(historyFile, `${JSON.stringify({ timestamp: new Date().toISOString(),
    message: { id: "usage-message", model: "freshness-model", usage: { input_tokens: tokens, output_tokens: 0 } },
  })}\n`);
}

/** Holds a real response; neither the service body nor HTTP status is fabricated. */
async function holdRefresh(page: Page) {
  let release!: () => void;
  let received!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { received = resolve; });
  const done = new Promise<void>((resolve) => { finished = resolve; });
  await page.route("**/api/usage/refresh?**", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    received();
    await gate;
    await route.fulfill({ response });
    finished();
  });
  return { ready, release: async () => { release(); await done; } };
}

test.beforeAll(async () => {
  service = await startService();
  const folder = join(service.dataDir, "../claude/projects/freshness");
  mkdirSync(folder, { recursive: true });
  historyFile = join(folder, "session.jsonl");
});
test.afterAll(async () => { await service?.stop(); });

test("a real local refresh keeps and dims figures, then applies its response", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  writeHistory(101);
  await page.goto(`${service.page}#/usage`);
  const row = page.getByRole("row", { name: /freshness-model/ });
  await expect(row).toContainText("101");
  const model = await row.elementHandle();
  writeHistory(202);
  const held = await holdRefresh(page);
  try {
    await page.getByRole("button", { name: "Refresh usage" }).click();
    await held.ready;
    await expect(page.getByRole("region", { name: "Usage" }).getByRole("status")).toHaveText("Refreshing usage…");
    await expect(row).toContainText("101");
    await expect(page.locator(".usage-stat strong").first()).toHaveCSS("transition-delay", "0s");
    await expect(page.locator(".usage-stat strong").first()).toHaveCSS("opacity", "0.4");
    await expect(page.locator(".usage-chart")).toHaveCSS("opacity", "0.4");
    expect(await model?.evaluate((element) => element.isConnected)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("refresh-pending.png") });
  } finally {
    await held.release();
  }
  await expect(row).toContainText("202");
  await expect(page.locator(".usage-stat strong").first()).toHaveCSS("opacity", "1");
  await expect(page.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
  await expect(row).toContainText("Unpriced");
  await page.screenshot({ path: test.info().outputPath("refresh-settled.png") });
});

test("an old refresh response cannot replace a newly selected period", async ({ page }) => {
  writeHistory(101);
  await page.goto(`${service.page}#/usage`);
  const row = page.getByRole("row", { name: /freshness-model/ });
  await expect(row).toContainText("101");
  writeHistory(202);
  const held = await holdRefresh(page);
  try {
    await page.getByRole("button", { name: "Refresh usage" }).click();
    await held.ready;
    writeHistory(303);
    await page.getByRole("radio", { name: "7 days" }).click();
    await expect(row).toContainText("303");
  } finally {
    await held.release();
  }
  // The old real response has been delivered before checking the selected period.
  await page.unroute("**/api/usage/refresh?**");
  await expect(row).toContainText("303");
  await expect(page.getByRole("radio", { name: "7 days" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
});

test("a failed transport retains figures and offers a working retry at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  writeHistory(404);
  await page.goto(`${service.page}#/usage`);
  const row = page.getByRole("row", { name: /freshness-model/ });
  await expect(row).toContainText("404");
  await page.route("**/api/usage/refresh?**", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Refresh usage" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't refresh usage");
  await expect(row).toContainText("404");
  await expect(page.locator(".usage-stat strong").first()).toHaveCSS("opacity", "1");
  await page.screenshot({ path: test.info().outputPath("refresh-error-narrow.png") });
  await page.unroute("**/api/usage/refresh?**");
  writeHistory(505);
  await page.getByRole("alert").getByRole("button", { name: "Retry" }).click();
  await expect(row).toContainText("505");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
