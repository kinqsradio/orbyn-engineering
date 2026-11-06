import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, type Service } from "./service";

/**
 * B54: coming back to an idle Claude thread after its prompt cache window offers
 * one compact action. The page's clock is moved past the window; the thread's
 * items keep the real service's timestamps.
 */

let service: Service;
let projectId = "";
const CACHE_MS = 5 * 60 * 1000;

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
});
test.afterAll(() => service.stop());

const offer = (page: Page) => page.getByRole("status").filter({ hasText: "prompt cache has expired" });

async function threadWithTurn(page: Page, engine: string) {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId, engine, model: null, title: `Compact ${engine}`, worktree: null, skill_profile: null,
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await send(page, "hello");
  await settled(service, thread.id);
  return thread.id;
}

const installed = new WeakSet<Page>();

/** Comes back to the thread as if it sat idle for `after`; the page's time then keeps running. */
async function returnLater(page: Page, after: number) {
  const time = Date.now() + after;
  if (installed.has(page)) {
    await page.clock.setSystemTime(time);
  } else {
    await page.clock.install({ time });
    installed.add(page);
  }
  await page.clock.resume();
  // The offer waits for the thread's commands, so every check below waits for them too.
  const commands = page.waitForResponse((response) => /\/api\/threads\/[^/]+\/commands$/.test(new URL(response.url()).pathname));
  await page.reload();
  expect((await commands).ok()).toBe(true);
  expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(time);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
}

test("an idle Claude thread offers compact on return after the cache window, and it runs /compact", async ({ page }) => {
  const id = await threadWithTurn(page, "claude");
  // Still warm on this visit and on a return inside the window.
  await expect(page.locator(".msg-assistant").last()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
  await returnLater(page, CACHE_MS - 60_000);
  await expect(page.locator(".msg-assistant").last()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);

  // Past the window, the offer waits for the compact command and can be dismissed for the visit.
  await returnLater(page, CACHE_MS + 60_000);
  await expect(offer(page)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss compact offer" }).click();
  await expect(offer(page)).toHaveCount(0);

  await returnLater(page, CACHE_MS + 60_000);
  await expect(offer(page)).toBeVisible();
  const request = page.waitForRequest((sent) => sent.method() === "POST" && sent.url().endsWith(`/api/threads/${id}/runs`));
  await offer(page).getByRole("button", { name: "Compact", exact: true }).click();
  expect(((await request).postDataJSON() as { prompt: string }).prompt).toBe("/compact");
  await expect(offer(page)).toHaveCount(0);
  await settled(service, id);
  await expect(page.locator(".msg-user").getByText("/compact")).toBeVisible();
});

test("another engine's thread is not offered compact after the same wait", async ({ page }) => {
  await threadWithTurn(page, "codex");
  await returnLater(page, CACHE_MS + 60_000);
  await expect(page.locator(".msg-assistant").last()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
});
