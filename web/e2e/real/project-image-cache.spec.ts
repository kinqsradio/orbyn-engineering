import { expect, test, type Page } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startProject } from "./service";

const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${color}"/></svg>`;
interface Cached { key: string; project_id: string; revision: string; data_url: string; used_at: number }
async function stored(page: Page): Promise<Cached[]> {
  return page.evaluate(async () => {
    // Observation must not create a version-1 database before the application
    // owns its schema upgrade. A cold store is simply not populated yet.
    if (!(await indexedDB.databases()).some((db) => db.name === "orbyn.project-images")) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("orbyn.project-images", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("images")) return [];
      return await new Promise<Cached[]>((resolve, reject) => {
        const request = db.transaction("images").objectStore("images").getAll();
        request.onsuccess = () => resolve(request.result as Cached[]); request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

test("real project images restore from IndexedDB, reuse matching bytes and clear authoritative misses", async ({ page }) => {
  const { service, projectId } = await startProject();
  const image = () => page.locator(".badge-image:not(.project-image-pending) img").first();
  try {
    writeFileSync(join(service.repo, "favicon.svg"), svg("blue"));
    await page.goto(`${service.page}#/new/${projectId}`);
    await expect(image()).toBeVisible(); await expect.poll(async () => (await stored(page)).filter((item) => item.project_id === projectId).length).toBe(1);
    const initial = (await stored(page)).find((item) => item.project_id === projectId)!;
    expect(initial.data_url).toContain("data:image/svg+xml;base64,");
    expect(JSON.stringify(initial)).not.toContain(new URL(service.url).port);
    expect(JSON.stringify(initial)).not.toContain(new URL(service.page).searchParams.get("token"));
    let rawReads = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname === `/api/projects/${projectId}/icon/raw`) rawReads += 1; });
    await page.reload(); await expect(image()).toHaveAttribute("src", initial.data_url);
    await expect.poll(async () => (await stored(page)).find((item) => item.project_id === projectId)?.used_at).toBeGreaterThan(initial.used_at);
    expect(rawReads).toBe(0);
    // Keep all project/metadata reads real; only the optional image observation fails.
    await page.route(`**/api/projects/${projectId}/icon/resource`, (route) => route.abort("failed"));
    await page.reload(); await expect(image()).toHaveAttribute("src", initial.data_url);
    await page.unroute(`**/api/projects/${projectId}/icon/resource`);
    rmSync(join(service.repo, "favicon.svg")); await page.reload();
    await expect(page.locator(".badge-image img")).toHaveCount(0);
    await expect.poll(async () => (await stored(page)).filter((item) => item.project_id === projectId).length).toBe(0);
  } finally { await service.stop(); }
});

test("a changed real image replaces its persisted revision after decoding", async ({ page }) => {
  const { service, projectId } = await startProject();
  try {
    writeFileSync(join(service.repo, "favicon.svg"), svg("blue"));
    await page.goto(`${service.page}#/new/${projectId}`);
    await expect.poll(async () => (await stored(page)).find((item) => item.project_id === projectId)?.revision).toMatch(/^[a-f0-9]{64}$/);
    const before = (await stored(page)).find((item) => item.project_id === projectId)!;
    writeFileSync(join(service.repo, "favicon.svg"), svg("red"));
    await page.reload();
    await expect.poll(async () => (await stored(page)).find((item) => item.project_id === projectId)?.revision).not.toBe(before.revision);
    const after = (await stored(page)).find((item) => item.project_id === projectId)!;
    expect(after.data_url).not.toBe(before.data_url);
    await expect(page.locator(".badge-image:not(.project-image-pending) img").first()).toHaveAttribute("src", after.data_url);
  } finally { await service.stop(); }
});

test("the real browser image store enforces byte/count bounds and fences clear, delete and project purge", async ({ page }) => {
  const { service, projectId } = await startProject();
  try {
    await page.goto(`${service.page}#/new/${projectId}`);
    const result = await page.evaluate(async () => {
      const modulePath = "/src/lib/projectImagePersistence.ts";
      const cache = await import(/* @vite-ignore */ modulePath) as typeof import("../../src/lib/projectImagePersistence");
      const item = (key: string, project_id = "cache-fixture", large = false) => ({ key, project_id, revision: "a".repeat(64),
        data_url: `data:image/png;base64,${large ? "A".repeat(32000) : "AQID"}`, used_at: Date.now() });
      const readAll = async () => {
        const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("orbyn.project-images", 1); open.onsuccess = () => resolve(open.result); });
        try { return await new Promise<Cached[]>((resolve) => { const get = db.transaction("images").objectStore("images").getAll(); get.onsuccess = () => resolve(get.result as Cached[]); }); }
        finally { db.close(); }
      };
      await cache.clearStoredProjectImages();
      const pending = cache.storeProjectImage(item("before-clear")); const cleared = cache.clearStoredProjectImages();
      const clearFence = [await pending, await cleared, await cache.readStoredProjectImage("before-clear", "cache-fixture")];
      const pendingDelete = cache.storeProjectImage(item("before-delete")); const deleted = cache.deleteStoredProjectImage("before-delete", "cache-fixture");
      const deleteFence = [await pendingDelete, await deleted, await cache.readStoredProjectImage("before-delete", "cache-fixture")];
      const pendingPurge = cache.storeProjectImage(item("before-purge")); const purged = cache.purgeStoredProjectImages("cache-fixture");
      const purgeFence = [await pendingPurge, await purged, await cache.readStoredProjectImage("before-purge", "cache-fixture")];
      for (let i = 0; i < 130; i += 1) await cache.storeProjectImage(item(`small-${i}`));
      const count = (await readAll()).length;
      await cache.clearStoredProjectImages();
      for (let i = 0; i < 40; i += 1) await cache.storeProjectImage(item(`large-${i}`, "cache-fixture", true));
      const bounded = await readAll();
      const invalid = await cache.storeProjectImage({ ...item("bad"), data_url: "https://fixture.invalid/image?token=secret" });
      return { clearFence, deleteFence, purgeFence, count, bytes: bounded.reduce((sum, row) => sum + row.data_url.length, 0),
        remaining: bounded.length, newest: bounded.some((row) => row.key === "large-39"), invalid };
    });
    expect(result.clearFence).toEqual([false, true, null]);
    expect(result.deleteFence).toEqual([false, true, null]);
    expect(result.purgeFence).toEqual([false, true, null]);
    expect(result.count).toBe(128); expect(result.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(result.remaining).toBeLessThan(40); expect(result.newest).toBe(true); expect(result.invalid).toBe(false);
  } finally { await service.stop(); }
});
