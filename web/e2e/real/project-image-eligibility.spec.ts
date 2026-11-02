import { expect, test, type Request, type Route } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, WorkspaceStatus } from "../../src/api/types";
import { libraryReady, startService } from "./service";

test("project images wait for workspace identity and never request the library image", async ({ page }) => {
  const service = await startService();
  let releaseWorkspace!: () => void;
  const heldWorkspace = new Promise<void>((resolve) => { releaseWorkspace = resolve; });
  const workspaceRoute = /\/api\/workspace(?:\?.*)?$/;
  const holdWorkspace = async (route: Route) => {
    if (route.request().method() === "GET") await heldWorkspace;
    await route.continue();
  };
  const imageRequests: string[] = [];
  const imagePaths: string[] = [];
  const recordImage = (request: Request) => {
    const path = new URL(request.url()).pathname;
    const match = path.match(/^\/api\/projects\/([^/]+)\/icon(?:\/(?:resource|raw))?$/);
    if (match) { imageRequests.push(decodeURIComponent(match[1]!)); imagePaths.push(path); }
  };
  try {
    await libraryReady(service);
    const project = await service.api<Project>("POST", "/api/projects/add", { path: service.repo });
    expect(project.trusted).toBe(false);
    const workspace = await service.api<WorkspaceStatus>("GET", "/api/workspace");
    const projects = await service.api<Project[]>("GET", "/api/projects");
    const library = projects.find((entry) => entry.path === workspace.library?.path);
    expect(library, "fixture includes the registered skills library identity").toBeDefined();
    expect(library!.id).not.toBe(project.id);
    writeFileSync(join(service.repo, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17"><rect width="17" height="17" fill="red"/></svg>');

    page.on("request", recordImage);
    await page.route(workspaceRoute, holdWorkspace);
    const projectsLoaded = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/projects" && response.status() === 200);
    const workspaceRequested = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/api/workspace" && request.method() === "GET");
    await page.goto(`${service.page}#/new/${project.id}`, { waitUntil: "domcontentloaded" });
    await projectsLoaded;
    await workspaceRequested;
    const projectRow = page.getByRole("link", { name: `Review trust for ${project.name}`, exact: true });
    await expect(projectRow).toBeVisible();
    await expect(projectRow.locator(".project-monogram")).toBeVisible();
    // A completed paint ensures the rendered badges have subscribed while the
    // actual workspace response is still held; no fixed delay masks the race.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(imageRequests).toEqual([]);
    await expect(page.locator(".badge-image img")).toHaveCount(0);

    releaseWorkspace();
    const image = projectRow.locator(".badge-image img");
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(17);
    expect(imagePaths).toEqual(expect.arrayContaining([`/api/projects/${project.id}/icon/resource`, `/api/projects/${project.id}/icon/raw`]));
    expect(imageRequests).toContain(project.id);
    expect(imageRequests).not.toContain(library!.id);
    expect(imageRequests.every((id) => id === project.id)).toBe(true);
  } finally {
    releaseWorkspace();
    page.off("request", recordImage);
    try { await page.unrouteAll({ behavior: "wait" }); }
    finally { await service.stop(); }
  }
});
