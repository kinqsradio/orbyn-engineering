import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { startProject } from "./service";

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
    let stopService = async () => {};
    try {
      const { service, projectId } = await startProject({ fakeEngines: true });
      stopService = () => service.stop();
      await page.setViewportSize({ width: 1600, height: 900 });
      await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_project_scripts: [{ name: "Preview action", command: "echo preview-action-ran", preview_url: `${origin}/action`, auto_open_preview: true }] } });
      const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Action preview" });
      const base = `/api/threads/${thread.id}`;
      const old = await service.api<{ id: string }>("POST", `${base}/previews`, { url: `${origin}/existing` });
      await page.goto(`${service.page}#/threads/${thread.id}`);
      if (entry === "terminal") {
        await page.getByRole("button", { name: "Terminal", exact: true }).click();
        await page.getByRole("button", { name: "Run a script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Preview action", exact: true }).click();
      } else {
        await page.getByRole("complementary", { name: "Thread details" }).getByRole("button", { name: "Preview action", exact: true }).click();
      }
      await expect(page.getByRole("combobox", { name: "Search or enter URL" })).toHaveValue(`${origin}/action`);
      await expect(page.getByRole("img", { name: `Page at ${origin}/action`, exact: true })).toBeVisible();
      const tabs = await service.api<{ id: string; url: string }[]>("GET", `${base}/previews`);
      expect(tabs).toHaveLength(2);
      expect(tabs.find((tab) => tab.id === old.id)?.url).toBe(`${origin}/existing`);
      await expect.poll(async () => {
        const terminals = await service.api<{ id: string; script: string | null }[]>("GET", `${base}/terminals`);
        const terminal = terminals.find((item) => item.script === "Preview action");
        return terminal ? (await service.api<{ text: string }>("GET", `${base}/terminals/${terminal.id}/scrollback`)).text : "";
      }).toContain("preview-action-ran");
    } finally {
      await stopService();
      await new Promise<void>((resolve, reject) => site.close((error) => error ? reject(error) : resolve()));
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
