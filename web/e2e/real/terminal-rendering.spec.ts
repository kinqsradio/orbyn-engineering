import { expect, test } from "@playwright/test";
import { startProject } from "./service";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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

test("rerunning the selected action attaches to its replacement process", async ({ page }, info) => {
  const { service, projectId } = await startProject();
  try {
    writeFileSync(join(service.repo, "counter.cjs"), `const fs = require('node:fs');
const next = Number(fs.existsSync('counter') ? fs.readFileSync('counter', 'utf8') : '0') + 1;
fs.writeFileSync('counter', String(next)); console.log('action-output-' + next);`);
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: {
      default_project_scripts: [{ name: "Counter output", command: "node counter.cjs" }],
    } });
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Replacement output" });
    await page.goto(`${service.page}#/threads/${thread.id}`);
    const run = page.getByRole("complementary", { name: "Thread details" }).getByRole("button", { name: "Counter output", exact: true });
    const rows = page.locator(".terminal-drawer-body .xterm-rows");
    await run.click();
    await expect(rows).toContainText("action-output-1");
    await run.click();
    await expect.poll(async () => {
      const terminals = await service.api<{ id: string; script: string | null }[]>("GET", `/api/threads/${thread.id}/terminals`);
      const action = terminals.find((terminal) => terminal.script === "Counter output");
      return action ? (await service.api<{ text: string }>("GET", `/api/threads/${thread.id}/terminals/${action.id}/scrollback`)).text : "";
    }).toContain("action-output-2");
    await expect(rows).toContainText("action-output-2");
    await expect(rows).not.toContainText("action-output-1");
    await page.screenshot({ path: info.outputPath("replacement-output.png") });
  } finally { await service.stop(); }
});
