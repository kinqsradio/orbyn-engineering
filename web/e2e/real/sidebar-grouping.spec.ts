import { expect, test, type Page } from "@playwright/test";
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

function fixtureFolders(page: Page) {
  return page.locator(".folder-head").filter({
    has: page.locator(".folder-name").filter({ hasText: /^(Owner\/Grouped|grouped-(one|two|three))$/ }),
  });
}

test("project folders group one repository, split on Separate and honor a checkout override", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${service.page}#/settings/threads`);
  await page.getByRole("switch", { name: "Group threads by project" }).check();
  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("radiogroup", { name: "Project grouping" }).getByRole("radio", { name: "Repository", exact: true }).click();
  await page.goto(service.page);

  await expect(fixtureFolders(page)).toHaveCount(1);
  await expect(fixtureFolders(page).filter({ hasText: "Owner/Grouped" })).toHaveCount(1);
  await expect(page.getByText("grouped-one thread", { exact: true })).toBeVisible();
  await expect(page.getByText("grouped-two thread", { exact: true })).toBeVisible();
  await expect(page.getByText("grouped-three thread", { exact: true })).toBeVisible();

  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("radiogroup", { name: "Project grouping" }).getByRole("radio", { name: "Separate", exact: true }).click();
  await page.goto(service.page);
  await expect(fixtureFolders(page)).toHaveCount(3);
  await expect(fixtureFolders(page).filter({ hasText: "grouped-one" })).toHaveCount(1);
  await expect(fixtureFolders(page).filter({ hasText: "grouped-two" })).toHaveCount(1);
  await expect(fixtureFolders(page).filter({ hasText: "grouped-three" })).toHaveCount(1);

  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("radiogroup", { name: "Project grouping" }).getByRole("radio", { name: "Repository", exact: true }).click();
  await page.goto(service.page);
  await fixtureFolders(page).filter({ hasText: "Owner/Grouped" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Grouping", exact: true }).hover();
  await page.getByRole("menuitem", { name: "grouped-two", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Separate", exact: true }).click();

  await expect(fixtureFolders(page)).toHaveCount(2);
  await expect(fixtureFolders(page).filter({ hasText: "Owner/Grouped" })).toHaveCount(1);
  await expect(fixtureFolders(page).filter({ hasText: "grouped-two" })).toHaveCount(1);
  await expect(fixtureFolders(page).filter({ hasText: "grouped-one" })).toHaveCount(0);
});

async function expectMembership(page: Page, expected: { label: string; threads: string[] }[]) {
  await expect.poll(() => folderMembership(page)).toEqual(expected);
  for (const name of ["grouped-one", "grouped-two", "grouped-three"]) {
    await expect(page.getByText(`${name} thread`, { exact: true })).toHaveCount(1);
    await expect(page.getByText(`${name} thread`, { exact: true })).toBeVisible();
  }
}

async function folderMembership(page: Page) {
  return fixtureFolders(page).evaluateAll((headers) =>
    headers.map((header) => {
      const threads: string[] = [];
      let row = header.nextElementSibling;
      while (row && !row.classList.contains("folder-head")) {
        const title = row.querySelector(".thread-row-title")?.textContent;
        if (title) threads.push(title);
        row = row.nextElementSibling;
      }
      return { label: header.querySelector(".folder-name")?.textContent, threads: threads.sort() };
    }).sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "")),
  );
}

test("Separate keeps explicit repository overrides and their thread membership after reload", async ({ page }) => {
  await page.goto(`${service.page}#/settings/threads`);
  await page.getByRole("switch", { name: "Group threads by project" }).check();
  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("radiogroup", { name: "Project grouping" }).getByRole("radio", { name: "Repository", exact: true }).click();
  await page.goto(service.page);
  await expect(fixtureFolders(page)).toHaveCount(1);

  for (const name of ["grouped-one", "grouped-two"]) {
    await fixtureFolders(page).filter({ hasText: "Owner/Grouped" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Grouping", exact: true }).hover();
    await page.getByRole("menuitem", { name, exact: true }).hover();
    await page.getByRole("menuitem", { name: "Repository", exact: true }).click();
  }

  await page.goto(`${service.page}#/settings/general`);
  await page.getByRole("radiogroup", { name: "Project grouping" }).getByRole("radio", { name: "Separate", exact: true }).click();
  await page.goto(service.page);

  const expected = [
    { label: "grouped-three", threads: ["grouped-three thread"] },
    { label: "Owner/Grouped", threads: ["grouped-one thread", "grouped-two thread"] },
  ];
  await expectMembership(page, expected);
  await page.reload();
  await expectMembership(page, expected);

  await page.route("**/api/settings/project-scopes", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  const unavailable = page.waitForResponse((response) =>
    response.url().endsWith("/api/settings/project-scopes") && response.status() === 503,
  );
  await page.reload();
  await unavailable;
  await expectMembership(page, [
    { label: "grouped-one", threads: ["grouped-one thread"] },
    { label: "grouped-three", threads: ["grouped-three thread"] },
    { label: "grouped-two", threads: ["grouped-two thread"] },
  ]);
});
