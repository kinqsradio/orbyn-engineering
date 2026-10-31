import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { startProject, type Service } from "./service";

/** The Browser surface driving the service's headless Chrome. */
const PORT = 5283;
const SITE_PORT = 5293;

let service: Service;
let threadId = "";
let site: Server;
let clicks = 0;

test.beforeAll(async () => {
  site = createServer((request, response) => {
    if (request.url === "/clicked") clicks += 1;
    response.setHeader("Content-Type", "text/html");
    response.end(`<body style="margin:0;background:#2a6"><button style="width:100vw;height:100vh" onclick="fetch('/clicked')">${request.url}</button></body>`);
  }).listen(SITE_PORT);
  const started = await startProject(PORT, { fakeEngines: true });
  service = started.service;
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: started.projectId,
    engine: started.engines[0]?.id,
    model: null,
    title: "Browser",
    worktree: null,
    skill_profile: null,
  });
  threadId = thread.id;
});
test.afterAll(() => {
  service.stop();
  site.close();
});

test("a page opens, streams, takes input under control, and tabs close", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${threadId}`);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
  await page.getByRole("button", { name: "Surfaces" }).click().catch(() => undefined);
  await page.getByRole("button", { name: /^Browser/ }).first().click();
  await expect(page.getByText("No preview yet")).toBeVisible();

  const address = page.getByRole("textbox", { name: "Search or enter URL" });
  await address.fill(`localhost:${SITE_PORT}/one`);
  await address.press("Enter");
  const frame = page.getByRole("img", { name: /^Page at/ });
  await expect(frame).toBeVisible({ timeout: 40_000 });

  await address.fill(`localhost:${SITE_PORT}/two`);
  await address.press("Enter");
  await expect(address).toHaveValue(new RegExp(`/two$`));
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(address).toHaveValue(new RegExp(`/one$`));
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(address).toHaveValue(new RegExp(`/two$`));
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(address).toHaveValue(new RegExp(`/one$`));

  const threadUrl = decodeURIComponent(page.url().split("/threads/")[1] ?? "");
  const size = async () => (await service.api<{ width: number }[]>("GET", `/api/threads/${threadUrl}/previews`))[0]?.width;
  const before = await size();
  await page.setViewportSize({ width: 1700, height: 900 });
  await expect.poll(size, { timeout: 10_000 }).not.toBe(before);

  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("button", { name: "Give control back" })).toBeVisible();
  await frame.click();
  await expect.poll(() => clicks, { timeout: 10_000 }).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Close tab" }).click();
  await expect(page.getByText("No preview yet")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent pages" })).toContainText("/one");
});
