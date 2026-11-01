import { expect, test } from "@playwright/test";
import { startService } from "./service";

test("exact setting search reveals Advanced and saves through the real service", async ({ page }, info) => {
  const service = await startService();
  try {
    await service.api("POST", "/api/workspace/setup", {});
    await page.goto(`${service.page}#/settings/general`);
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await search.fill("Branch prefix"); // Neither this label nor 'prefix' occurred in the old section keywords.
    await page.getByRole("link", { name: "Branch prefix · Worktrees", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/worktrees$/);
    const row = page.locator("#worktrees-branch-prefix");
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
    const branchDisclosure = page.locator(".collapsible-panel").filter({ has: row }).locator("..");
    const branchAdvanced = branchDisclosure.getByRole("button", { name: "Advanced", exact: true });
    const cleanupPanel = page.locator(".collapsible-panel").filter({ has: page.locator("#worktrees-delete-settled") });
    const cleanupAdvanced = cleanupPanel.locator("..").getByRole("button", { name: "Advanced", exact: true });
    await expect(branchAdvanced).toHaveAttribute("aria-expanded", "true");
    await expect(cleanupAdvanced).toHaveAttribute("aria-expanded", "false");
    await expect(cleanupPanel).toBeHidden();
    const prefix = page.getByRole("textbox", { name: "Branch prefix", exact: true });
    await prefix.fill("search-proof");
    await prefix.press("Tab");
    type Preference = { key: string; value: unknown };
    await expect.poll(async () => (await service.api<Preference[]>("GET", "/api/preferences")).find((entry) => entry.key === "branch_name_prefix")?.value).toBe("search-proof");
    await page.screenshot({ path: info.outputPath("settings-search-desktop.png") });
    await page.reload();
    await search.fill("Branch prefix");
    await page.getByRole("link", { name: "Branch prefix · Worktrees", exact: true }).click();
    await expect(prefix).toHaveValue("search-proof");
    await expect(row).toBeFocused();
    await expect(branchAdvanced).toHaveAttribute("aria-expanded", "true");
    await expect(cleanupAdvanced).toHaveAttribute("aria-expanded", "false");
    await page.setViewportSize({ width: 720, height: 480 });
    await search.fill("Command line tool");
    await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("status")).toHaveText("No settings found");
    await search.fill("Branch prefix");
    await page.getByRole("link", { name: "Branch prefix · Worktrees", exact: true }).click();
    await expect(row).toBeFocused();
    await expect(branchAdvanced).toHaveAttribute("aria-expanded", "true");
    await expect(cleanupAdvanced).toHaveAttribute("aria-expanded", "false");
    await page.screenshot({ path: info.outputPath("settings-search-narrow.png") });
  } finally {
    await service.stop();
  }
});
