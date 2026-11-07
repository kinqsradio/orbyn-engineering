import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openPanelTab, startProject, type Service } from "./service";

let clicks = 0;
let site: Server;
let service: Service;
let threadId = "";
let origin = "";
let tabId = "";

test.beforeAll(async () => {
  site = createServer((request, response) => {
    if (request.url === "/clicked") clicks += 1;
    response.setHeader("Content-Type", "text/html");
    response.end(`<title>Page ${request.url}</title><p>${request.url}</p><button style="position:absolute;left:180px;top:380px;width:40px;height:40px" onclick="fetch('/clicked')">Tap</button>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing site address");
  origin = `http://127.0.0.1:${address.port}`;
  const started = await startProject({ fakeEngines: true });
  service = started.service;
  const { projectId } = started;
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Panels" });
  threadId = thread.id;
});

test.beforeAll(async () => {
  const base = `/api/threads/${threadId}/previews`;
  const tab = await service.api<{ id: string }>("POST", base, { url: `${origin}/one` });
  tabId = tab.id;
  await service.api("POST", base, { url: `${origin}/two` });
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

test("moves the same service tab between panels and watches only that tab in the separate viewer", async ({ page }) => {
  const base = `/api/threads/${threadId}/previews`;
  const tab = { id: tabId };
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${service.page}#/threads/${threadId}`);
  await openPanelTab(page, "Browser");
  const primary = page.getByRole("region", { name: "Browser panel", exact: true });
  await primary.getByRole("tab", { name: "Page /one", exact: true }).click();
  await primary.getByRole("button", { name: "More page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to another panel", exact: true }).click();
  const secondary = page.getByRole("region", { name: "Second Browser panel", exact: true });
  await expect(secondary.getByRole("tab", { name: "Page /one", exact: true })).toBeVisible();
  await expect(primary.getByRole("tab", { name: "Page /one", exact: true })).toHaveCount(0);
  await expect(secondary.getByRole("img", { name: /Page at/ })).toBeVisible();
  const ids = (await service.api<{ id: string }[]>("GET", base)).map((entry) => entry.id);
  expect(ids).toHaveLength(2);
  expect(ids).toContain(tab.id);
  await secondary.getByRole("button", { name: "More page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to Browser panel", exact: true }).click();
  await expect(secondary).toHaveCount(0);
  await expect(primary.getByRole("tab")).toHaveCount(2);
  await expect(service.api("POST", `${base}/${tab.id}/window`)).rejects.toThrow("422");
  await page.goto(`${service.page}#/preview/${threadId}/${tab.id}`);
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Page /one", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /Page at/ })).toBeVisible();
  expect((await service.api<{ id: string }[]>("GET", base)).map((entry) => entry.id).sort()).toEqual(ids.sort());
  await service.api("POST", `${base}/${tab.id}/resize`, { width: 400, height: 800 });
  await service.api("POST", `${base}/${tab.id}/control`, { human: true });
  const frame = page.getByRole("img", { name: /Page at/ });
  await expect.poll(async () => {
    const box = await frame.boundingBox();
    return box ? box.width / box.height : 0;
  }).toBeCloseTo(0.5, 2);
  await expect(page.getByRole("button", { name: "Give control back" })).toBeVisible();
  const box = await frame.boundingBox();
  if (!box) throw new Error("Missing preview frame");
  await frame.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect.poll(() => clicks).toBe(1);
  await frame.focus();
  await page.keyboard.press("ControlOrMeta+=");
  await expect.poll(async () => (await service.api<{ id: string; zoom: number }[]>("GET", base)).find((entry) => entry.id === tab.id)?.zoom).toBe(1.25);
});
