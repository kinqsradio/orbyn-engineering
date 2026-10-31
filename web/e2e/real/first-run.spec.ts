import { expect, test } from "@playwright/test";
import { startService, type Service } from "./service";

/** A fresh install against the real service, which the mock can't reach. */
const PORT = 5276;
/** The desktop window less its native title bar. */
const WINDOW = { width: 1280, height: 792 };

let service: Service;

test.beforeAll(async () => {
  service = await startService(PORT);
});

test.afterAll(() => service.stop());

test("first run shows a composed setup card and reaches the workspace", async ({ page }) => {
  await page.setViewportSize(WINDOW);
  await page.goto(service.page);

  const heading = page.getByRole("heading", { name: "Set up your workspace" });
  await expect(heading).toBeVisible();

  const card = await page.locator(".standalone-card").boundingBox();
  if (!card) throw new Error("no setup card");
  expect(card.width).toBe(576);
  expect(Math.abs(card.x - (WINDOW.width - card.width) / 2)).toBeLessThanOrEqual(1);
  expect(card.y).toBeGreaterThanOrEqual(40);
  expect(WINDOW.height - (card.y + card.height)).toBeGreaterThanOrEqual(40);

  const managed = await page.getByText("Set up managed workspace").boundingBox();
  const adopt = await page.getByText("Adopt an existing library").boundingBox();
  if (!managed || !adopt) throw new Error("no choices");
  expect(adopt.y).toBeGreaterThan(managed.y + managed.height + 16);
  expect(managed.x).toBeGreaterThan(card.x + 16);

  await page.getByRole("radio", { name: /Adopt an existing library/ }).check();
  await expect(page.getByRole("button", { name: "Adopt this folder" })).toBeVisible();
  const opened = await page.locator(".standalone").evaluate((element) => ({
    top: element.querySelector(".standalone-card")?.getBoundingClientRect().top ?? 0,
    pageOverflow: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(opened.top).toBeGreaterThanOrEqual(40);
  expect(opened.pageOverflow).toBeLessThanOrEqual(0);

  await page.getByRole("radio", { name: /Set up managed workspace/ }).check();
  await page.getByRole("button", { name: "Set up workspace" }).click();
  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Skills library")).toBeHidden();
});
