import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProject, type Service } from "./service";

let service: Service;
let projectId: string;
let outside: string;
test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "orbyn-outside-")));
});
test.afterAll(async () => {
  await service?.stop();
  if (outside) rmSync(outside, { recursive: true, force: true });
});

test("a file outside the checkout opens read-only and its HTML stays isolated", async ({ page }) => {
  const page_ = join(outside, "report.html");
  const html = `<p id="seen">outside page</p><script>parent.document.title = "pwned"; document.body.dataset.ran = "yes";</script>`
    + `<img src="${service.url}/api/threads?probe=outside" alt="probe">`;
  writeFileSync(page_, html);
  writeFileSync(join(service.repo, "inside.txt"), "inside\n");
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId, engine: "codex", model: null, title: "Outside files", worktree: null, skill_profile: null,
  });
  // The page's probe must be stopped by its policy and never answered.
  const answered: string[] = [];
  const blocked: string[] = [];
  page.on("response", (response) => { if (response.url().includes("probe=outside")) answered.push(response.url()); });
  page.on("requestfailed", (request) => { if (request.url().includes("probe=outside")) blocked.push(request.failure()?.errorText ?? ""); });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
  const title = await page.title();

  // Reach the Files panel through a checkout file, then name the outside one by its full path.
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search" }).fill("inside.txt");
  await palette.getByRole("button", { name: /inside\.txt/ }).first().click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search files" });
  await search.fill(page_);
  await search.press("Enter");

  const viewer = page.locator(".files-viewer.outside-file");
  await expect(viewer.getByText(/Outside checkout · Read-only/)).toBeVisible();
  for (const name of ["Edit", "Save"]) await expect(viewer.getByRole("radio", { name })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: "Save file" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Open in editor" })).toHaveCount(0);

  const frame = viewer.locator("iframe.file-frame");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(page.frameLocator(".outside-file iframe.file-frame").locator("#seen")).toHaveText("outside page");
  // The page's script never ran, here or in the app, and it fetched nothing from the API.
  await expect(page.frameLocator(".outside-file iframe.file-frame").locator("body")).not.toHaveAttribute("data-ran", "yes");
  expect(await page.title()).toBe(title);
  await expect.poll(() => blocked).toEqual(["csp"]);
  expect(answered).toEqual([]);

  await viewer.getByRole("radio", { name: "Source" }).click();
  await expect(viewer.locator("pre.file-source")).toContainText("parent.document.title");
  expect(readFileSync(page_, "utf8")).toBe(html);

  // A path inside the checkout or into Orbyn's data is refused by the service.
  await viewer.getByRole("button", { name: "Files", exact: true }).click();
  const data = realpathSync(service.dataDir);
  const held = readdirSync(data).map((name) => join(data, name)).find((path) => statSync(path).isFile());
  expect(held).toBeTruthy();
  await search.fill(held!);
  await search.press("Enter");
  await expect(page.getByText(/own data isn't shown here/)).toBeVisible();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await search.fill(join(realpathSync(service.repo), "inside.txt"));
  await search.press("Enter");
  await expect(page.getByText(/in this checkout\. Open it from Files/)).toBeVisible();
});
