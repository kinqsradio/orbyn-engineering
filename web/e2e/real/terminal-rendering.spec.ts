import { expect, test } from "@playwright/test";
import { startProject } from "./service";

test("completed action output is visible on first attach and tab return", async ({ page }) => {
  const { service, projectId } = await startProject();
  try {
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: {
      default_project_scripts: [{ name: "Visible output", command: "echo action-visible-output" }],
    } });
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Terminal rendering" });
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await page.getByRole("complementary", { name: "Thread details" }).getByRole("button", { name: "Visible output", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Visible output", exact: true })).toHaveAttribute("aria-selected", "true");
    const rows = page.locator(".terminal-drawer-body .xterm-rows");
    await expect(rows).toContainText("action-visible-output");
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await page.getByRole("tab", { name: "Visible output", exact: true }).click();
    await expect(rows).toContainText("action-visible-output");
  } finally { await service.stop(); }
});
