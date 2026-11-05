import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { libraryReady, startService, type Service } from "./service";

interface Project {
  id: string;
  name: string;
  path: string;
}

let service: Service;

test.beforeAll(async () => {
  service = await startService({ fakeEngines: true });
  await libraryReady(service);
  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  for (const name of ["grouped-one", "grouped-two", "grouped-three"]) {
    const project = await service.api<Project>("POST", "/api/projects/create", { name, readme: true });
    execFileSync(
      "git",
      ["-C", project.path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Owner/Grouped.git"],
      { stdio: "ignore" },
    );
    await service.api("POST", `/api/projects/${project.id}/trust`);
    await service.api("POST", "/api/threads", {
      project_id: project.id,
      engine: engines[0]?.id,
      title: `${name} thread`,
    });
  }
});

test.afterAll(() => service.stop());

test("project folders group one repository, split on Separate and honor a checkout override", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${service.page}#/settings/labs`);
  await page.getByRole("switch", { name: "Project folders" }).check();
  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("combobox", { name: "Project grouping" }).selectOption("repository");
  await page.goto(service.page);

  await expect(page.locator(".folder-head")).toHaveCount(1);
  await expect(page.locator(".folder-head").filter({ hasText: "Owner/Grouped" })).toHaveCount(1);
  await expect(page.getByText("grouped-one thread", { exact: true })).toBeVisible();
  await expect(page.getByText("grouped-two thread", { exact: true })).toBeVisible();
  await expect(page.getByText("grouped-three thread", { exact: true })).toBeVisible();

  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("combobox", { name: "Project grouping" }).selectOption("separate");
  await page.goto(service.page);
  await expect(page.locator(".folder-head")).toHaveCount(3);
  await expect(page.locator(".folder-head").filter({ hasText: "grouped-one" })).toHaveCount(1);
  await expect(page.locator(".folder-head").filter({ hasText: "grouped-two" })).toHaveCount(1);
  await expect(page.locator(".folder-head").filter({ hasText: "grouped-three" })).toHaveCount(1);

  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("combobox", { name: "Project grouping" }).selectOption("repository");
  await page.goto(service.page);
  await page.locator(".folder-head").filter({ hasText: "Owner/Grouped" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Grouping", exact: true }).hover();
  await page.getByRole("menuitem", { name: "grouped-two", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Separate", exact: true }).click();

  await expect(page.locator(".folder-head")).toHaveCount(2);
  await expect(page.locator(".folder-head").filter({ hasText: "Owner/Grouped" })).toHaveCount(1);
  await expect(page.locator(".folder-head").filter({ hasText: "grouped-two" })).toHaveCount(1);
  await expect(page.locator(".folder-head").filter({ hasText: "grouped-one" })).toHaveCount(0);
});
