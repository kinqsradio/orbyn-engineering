import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startProject, type Service } from "./service";

for (const entry of ["terminal", "details"] as const) {
  test(`${entry} action opens its saved preview and selects the new tab`, async ({ page }) => {
    const site = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<title>Action preview</title><p>${request.url}</p>`);
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    let service: Service | undefined;
    let base: string | undefined;
    let failure: unknown;
    let failed = false;
    const cleanupErrors: unknown[] = [];
    try {
      const started = await startProject({ fakeEngines: true, parentStdin: true });
      const fixture = started.service;
      service = fixture;
      const { projectId } = started;
      await page.setViewportSize({ width: 1600, height: 900 });
      await fixture.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_project_scripts: [{ name: "Preview action", command: "echo preview-action-ran", preview_url: `${origin}/action`, auto_open_preview: true }] } });
      const thread = await fixture.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Action preview" });
      const threadBase = `/api/threads/${thread.id}`;
      base = threadBase;
      const old = await fixture.api<{ id: string }>("POST", `${threadBase}/previews`, { url: `${origin}/existing` });
      await page.goto(`${fixture.page}#/threads/${thread.id}`);
      if (entry === "terminal") {
        await page.getByRole("button", { name: "Terminal", exact: true }).click();
        await page.getByRole("button", { name: "Run a script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Preview action", exact: true }).click();
      } else {
        await page.getByRole("complementary", { name: "Thread details" }).getByRole("button", { name: "Preview action", exact: true }).click();
      }
      await expect(page.getByRole("combobox", { name: "Search or enter URL" })).toHaveValue(`${origin}/action`);
      await expect(page.getByRole("img", { name: `Page at ${origin}/action`, exact: true })).toBeVisible();
      const tabs = await fixture.api<{ id: string; url: string }[]>("GET", `${threadBase}/previews`);
      expect(tabs).toHaveLength(2);
      expect(tabs.find((tab) => tab.id === old.id)?.url).toBe(`${origin}/existing`);
      await expect.poll(async () => {
        const terminals = await fixture.api<{ id: string; script: string | null }[]>("GET", `${threadBase}/terminals`);
        const terminal = terminals.find((item) => item.script === "Preview action");
        return terminal ? (await fixture.api<{ text: string }>("GET", `${threadBase}/terminals/${terminal.id}/scrollback`)).text : "";
      }).toContain("preview-action-ran");
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (service && base) {
        try {
          const tabs = await service.api<{ id: string }[]>("GET", `${base}/previews`);
          for (const tab of tabs) {
            try { await service.api("DELETE", `${base}/previews/${encodeURIComponent(tab.id)}`); }
            catch (error) { cleanupErrors.push(error); }
          }
          const dataDir = service.dataDir;
          const profiles = tabs.map((tab) => join(dataDir, "preview-profiles", tab.id));
          await expect.poll(() => profiles.every((profile) => !existsSync(profile)), { timeout: 5_000 }).toBe(true);
        } catch (error) { cleanupErrors.push(error); }
      }
      if (service) {
        try { await service.stop(); } catch (error) { cleanupErrors.push(error); }
      }
      try { await new Promise<void>((resolve, reject) => site.close((error) => error ? reject(error) : resolve())); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (failed || cleanupErrors.length) {
      throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], "Action preview test or cleanup failed");
    }
  });
}

test("an action with automatic preview disabled runs without opening a browser", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_project_scripts: [{ name: "Manual preview", command: "echo no-auto-preview", preview_url: "http://127.0.0.1:1/unused", auto_open_preview: false }] } });
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Manual preview" });
    const base = `/api/threads/${thread.id}`;
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByRole("button", { name: "Run a script", exact: true }).click();
    await page.getByRole("menuitem", { name: "Manual preview", exact: true }).click();
    await expect.poll(async () => {
      const terminals = await service.api<{ id: string; script: string | null }[]>("GET", `${base}/terminals`);
      const terminal = terminals.find((item) => item.script === "Manual preview");
      return terminal ? (await service.api<{ text: string }>("GET", `${base}/terminals/${terminal.id}/scrollback`)).text : "";
    }).toContain("no-auto-preview");
    expect(await service.api("GET", `${base}/previews`)).toEqual([]);
    await expect(page.getByRole("combobox", { name: "Search or enter URL" })).toHaveCount(0);
  } finally { await service.stop(); }
});

test("a rejected preview URL does not report the launched command as failed", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_project_scripts: [{ name: "Rejected preview", command: "echo action-still-ran", preview_url: "file:///not-a-web-preview", auto_open_preview: true }] } });
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Rejected preview" });
    const base = `/api/threads/${thread.id}`;
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByRole("button", { name: "Run a script", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rejected preview", exact: true }).click();
    await expect(page.getByText(/^Could not open preview\./)).toBeVisible();
    await expect(page.getByText(/Couldn't run Rejected preview/)).toHaveCount(0);
    await expect.poll(async () => {
      const terminals = await service.api<{ id: string; script: string | null }[]>("GET", `${base}/terminals`);
      const terminal = terminals.find((item) => item.script === "Rejected preview");
      return terminal ? (await service.api<{ text: string }>("GET", `${base}/terminals/${terminal.id}/scrollback`)).text : "";
    }).toContain("action-still-ran");
    expect(await service.api("GET", `${base}/previews`)).toEqual([]);
  } finally { await service.stop(); }
});
