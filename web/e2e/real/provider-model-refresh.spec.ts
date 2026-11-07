import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProject, type Service } from "./service";

const root = mkdtempSync(join(tmpdir(), "orbyn-model-refresh-"));
let service: Service;
test.beforeAll(async () => {
  writeFileSync(join(root, "lost-models"), "");
  ({ service } = await startProject({ fakeEngines: true, engineLaunchLog: join(root, "launches") }));
});
test.afterAll(() => service.stop());

// Protocol doubles exercise service cache orchestration, not provider qualification.
test("model refresh retains the real service's good list after discovery failure and recovers", async ({ page }, info) => {
  await page.goto(`${service.page}#/settings/providers`);
  await page.getByRole("table", { name: "Providers" }).getByRole("button", { name: "Codex", exact: true }).click();
  const row = page.getByRole("region", { name: "Settings" });
  const refresh = row.getByRole("button", { name: "Refresh Codex models", exact: true });
  await expect(row.getByRole("status")).toContainText("Try refreshing again.");
  unlinkSync(join(root, "lost-models"));
  await refresh.click();
  await expect(row.getByText("Fake Big", { exact: true })).toBeVisible();
  writeFileSync(join(root, "lost-models"), "");
  const failed = page.waitForResponse((response) => response.url().includes("/api/engines/codex/models?refresh=true"));
  await refresh.click();
  const reply = await (await failed).json();
  expect(reply.error).toBeTruthy();
  expect(reply.models.some((model: { id: string }) => model.id === "fake-big")).toBe(true);
  await expect(row.getByRole("status")).toContainText("Showing the last available list.");
  await expect(row.getByText("Fake Big", { exact: true })).toBeVisible();
  await expect(refresh).toBeEnabled();
  await page.screenshot({ path: info.outputPath("model-refresh-failure.png") });
  unlinkSync(join(root, "lost-models"));
  await refresh.click();
  await expect(row.getByRole("status")).toHaveCount(0);
  await expect(refresh).toBeEnabled();
  await expect(row.getByText("Fake Big", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("model-refresh-recovered.png") });
});
