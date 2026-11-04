import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { startProject, type Service } from "./service";

/** The Browser surface driving the service's headless Chrome. */
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
  const started = await startProject({ fakeEngines: true });
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
test.afterAll(async () => {
  await service.stop();
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

  const address = page.getByRole("combobox", { name: "Search or enter URL" });
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

  const zoom = async () => (await service.api<{ zoom: number }[]>("GET", `/api/threads/${threadUrl}/previews`))[0]?.zoom;
  await frame.focus();
  await page.keyboard.press("ControlOrMeta+=");
  await expect.poll(zoom).toBeGreaterThan(1);
  await page.keyboard.press("ControlOrMeta+0");
  await expect.poll(zoom).toBe(1);
  await page.keyboard.press("ControlOrMeta+-");
  await expect.poll(zoom).toBeLessThan(1);
  await page.keyboard.press("ControlOrMeta+0");
  await expect.poll(zoom).toBe(1);

  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("button", { name: "Give control back" })).toBeVisible();
  await frame.click();
  await expect.poll(() => clicks, { timeout: 10_000 }).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Close tab" }).click();
  await expect(page.getByText("No preview yet")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent pages" })).toContainText("/one");
});

test("the device toolbar resizes the page from its edges", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${threadId}`);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
  await page.getByRole("button", { name: "Surfaces" }).click().catch(() => undefined);
  await page.getByRole("button", { name: /^Browser/ }).first().click();
  const address = page.getByRole("combobox", { name: "Search or enter URL" });
  await address.fill(`localhost:${SITE_PORT}/one`);
  await address.press("Enter");
  await expect(page.getByRole("img", { name: /^Page at/ })).toBeVisible({ timeout: 40_000 });

  const tab = async () => (await service.api<{ width: number; height: number }[]>("GET", `/api/threads/${threadId}/previews`))[0];
  await page.getByRole("button", { name: "More page actions" }).click();
  await page.getByRole("menuitem", { name: "Show device toolbar" }).click();
  await page.getByRole("combobox", { name: "Device" }).selectOption("phone");
  await expect.poll(async () => (await tab())?.width, { timeout: 15_000 }).toBe(393);

  // The service can finish the preset before the viewer reloads it. Measuring
  // the old box would aim the press outside the edge once the phone is drawn.
  await expect(page.getByRole("combobox", { name: "Device" })).toHaveValue("phone");
  const dimensions = page.getByRole("toolbar", { name: "Device toolbar" }).locator("span");
  await expect(dimensions).toHaveText("393 by 852");
  const handle = page.getByRole("button", { name: /Resize the page from the right edge/ });
  await handle.hover();
  const box = await handle.boundingBox();
  if (!box) throw new Error("the right edge has no box to drag");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(handle).toHaveAttribute("data-dragging", "true");
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 10 });
  await expect(dimensions).not.toHaveText("393 by 852");
  await expect.poll(async () => (await tab())?.width, { timeout: 15_000 }).toBe(393);
  const resized = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().includes(`/api/threads/${threadId}/previews/`) && response.url().endsWith("/resize"),
  );
  await page.mouse.up();
  expect((await resized).ok()).toBe(true);

  // One resize for the whole drag, and the page is no preset any more.
  await expect.poll(async () => (await tab())?.width, { timeout: 15_000 }).toBeGreaterThan(450);
  await expect.poll(async () => (await tab())?.height, { timeout: 15_000 }).toBe(852);
  await expect(page.getByRole("combobox", { name: "Device" })).toHaveValue("custom");
});
