import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startProject, type Service } from "./service";

const icon = "https://127.0.0.1/icon.png";
let site: Server;
let service: Service;
let threadId = "";
let origin = "";

test.beforeAll(async () => {
  site = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<title>Icon discovery</title><link rel="icon" href="${icon}"><p>Icon page</p>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing site address");
  origin = `http://127.0.0.1:${address.port}`;
  const started = await startProject({ fakeEngines: true });
  service = started.service;
  const { projectId } = started;
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Icons" });
  threadId = thread.id;
});

test.afterAll(async () => {
  if (service) {
    const base = `/api/threads/${threadId}/previews`;
    for (const tab of await service.api<{ id: string }[]>("GET", base)) {
      await service.api("DELETE", `${base}/${tab.id}`);
      await expect.poll(() => existsSync(join(service.dataDir, "preview-profiles", tab.id))).toBe(false);
    }
    await service.stop();
  }
  if (site) await new Promise<void>((resolve, reject) => site.close((error) => error ? reject(error) : resolve()));
});

test("discovers a page icon through the real browser and keeps refused destinations behind the image proxy", async ({ page }) => {
  const base = `/api/threads/${threadId}/previews`;
  const tab = await test.step("Open the real preview and discover its icon", () => service.api<{ id: string; favicon_url?: string }>("POST", base, { url: `${origin}/` }));
  expect(tab.favicon_url).toBe(icon);
  const refused = page.waitForResponse((response) => response.url().includes("/api/media/image?") && response.status() === 502);
  await page.goto(`${service.page}#/preview/${threadId}/${tab.id}`);
  await expect(page.getByRole("tab", { name: "Icon discovery" })).toBeVisible();
  await refused;
  await expect(page.locator(".browser-tab-icon")).toHaveCount(0);
  // Loopback remains refused; the app never rewrites it into a direct image URL.
  await expect(page.locator('img[src^="https://127.0.0.1"]')).toHaveCount(0);
  // Refused bytes never become a remembered icon.
  expect(await page.evaluate(() => localStorage.getItem("orbyn.browser-icons.v1"))).toBeNull();
  await service.api("POST", `${base}/${tab.id}/navigate`, { url: `${origin}/next` });
  await expect(page.getByRole("combobox", { name: "Search or enter URL" })).toHaveValue(/\/next$/);
});
