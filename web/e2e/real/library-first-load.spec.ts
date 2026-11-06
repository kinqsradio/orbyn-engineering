import { expect, test } from "@playwright/test";
import { startProject, type Service } from "./service";

/** The bundled skills library is a project of its own that the sidebar never shows. */
let service: Service;

test.beforeAll(async () => {
  ({ service } = await startProject({ fakeEngines: true }));
});

test.afterAll(async () => {
  await service?.stop();
});

test("a slow workspace status never shows the library or a trust warning, and loads once", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path.startsWith("/api/")) requests.push(path);
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/workspace", async (route) => {
    await held;
    await route.continue();
  });
  // Every text the sidebar ever shows, so a flash between two checks is still caught.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { sidebarSeen: string[] }).sidebarSeen = seen;
    new MutationObserver(() => {
      for (const nav of document.querySelectorAll("nav, aside")) seen.push(nav.textContent ?? "");
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.goto(service.page);
  const sidebar = page.getByRole("navigation").first();
  await expect(sidebar).toContainText("repo", { timeout: 15_000 });
  const projectsLoaded = requests.filter((path) => path === "/api/projects").length;
  release();
  await expect.poll(() => requests.includes("/api/workspace")).toBe(true);
  await page.waitForLoadState("networkidle");
  const seen = await page.evaluate(() => (window as unknown as { sidebarSeen: string[] }).sidebarSeen.join("\n"));
  expect(seen).not.toContain("Skills library");
  expect(seen).not.toContain("Not trusted");
  await expect(sidebar).not.toContainText("Skills library");
  // One round on load, before the first poll.
  expect(projectsLoaded).toBe(1);
  for (const path of ["/api/workspace", "/api/approvals", "/api/updates"]) {
    expect(requests.filter((request) => request === path).length, path).toBeLessThanOrEqual(1);
  }
});
