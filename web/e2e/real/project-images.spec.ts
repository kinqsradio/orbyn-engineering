import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startProject } from "./service";
import type { ProjectIconImage } from "../../src/generated/ProjectIconImage";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>';

test("registered project images render through shared identities and missing files fall back", async ({ page }, info) => {
  const { service, projectId } = await startProject();
  try {
    mkdirSync(join(service.repo, "assets"), { recursive: true });
    writeFileSync(join(service.repo, "assets/chosen.svg"), svg);
    writeFileSync(join(service.repo, "orbyn.json"), JSON.stringify({ iconPath: "assets/chosen.svg" }));
    writeFileSync(join(service.repo, "favicon.svg"), svg.replace("red", "blue"));
    const first = await service.api<ProjectIconImage>("GET", `/api/projects/${projectId}/icon`);
    expect(first.image).toMatchObject({ source: "project_file", relative_path: "assets/chosen.svg", media_type: "svg" });
    await page.goto(`${service.page}#/new/${projectId}`);
    const images = page.locator(".badge-image img");
    await expect(images.first()).toBeVisible();
    await expect.poll(() => images.first().evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(16);
    const expected = `data:image/svg+xml;base64,${first.image!.data_base64}`;
    for (const image of await images.all()) await expect(image).toHaveAttribute("src", expected);
    rmSync(join(service.repo, "assets/chosen.svg"));
    const automatic = await service.api<ProjectIconImage>("GET", `/api/projects/${projectId}/icon`);
    expect(automatic.image).toMatchObject({ source: "automatic", relative_path: "favicon.svg" });
    expect(automatic.image?.revision).not.toBe(first.image?.revision);
    await page.reload();
    await expect(images.first()).toHaveAttribute("src", `data:image/svg+xml;base64,${automatic.image!.data_base64}`);
    rmSync(join(service.repo, "favicon.svg"));
    await page.reload();
    await expect(page.locator(".settings-dialog")).toHaveCount(0);
    await expect(page.locator(".badge").first()).toBeVisible();
    await expect(images).toHaveCount(0);
    await service.api("PATCH", `/api/projects/${projectId}`, { name: "B24 Worker UI" });
    await page.reload();
    await expect(page.locator(".project-monogram > span").first()).toHaveText("B2");
    await page.screenshot({ path: info.outputPath("automatic-badge.png") });
  } finally { await service.stop(); }
});

test("project SVG image mode executes no script and fetches no external resource", async ({ page }) => {
  let leaks = 0;
  const receiver = createServer((_request, response) => { leaks += 1; response.end("unexpected"); });
  await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));
  const { port } = receiver.address() as AddressInfo;
  const { service, projectId } = await startProject();
  try {
    const external = `http://127.0.0.1:${port}/image-leak`;
    writeFileSync(join(service.repo, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16" onload="fetch('${external}')"><script>parent.orbynImageScriptExecuted=true;fetch('${external}')</script><script xlink:href="${external}"/><image href="${external}"/><rect width="16" height="16" fill="red"/></svg>`);
    await page.goto(`${service.page}#/new/${projectId}`);
    const image = page.locator(".badge-image img").first();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(16);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(await page.evaluate(() => Object.hasOwn(window, "orbynImageScriptExecuted"))).toBe(false);
    expect(leaks).toBe(0);
  } finally {
    await service.stop();
    await new Promise<void>((done) => receiver.close(() => done()));
  }
});
