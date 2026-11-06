import { expect, test, type Page } from "@playwright/test";
import { send, settled, startProject, type Service } from "./service";

/**
 * B54: Claude's usage report names the cache lifetime its turn wrote. A one-hour
 * write keeps the thread warm past five minutes, so compact is offered only once
 * the hour has gone. The report is the shape the real CLI sends on its result.
 */

let service: Service;
let projectId = "";
const CACHE_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({
    claudeUsage: {
      input_tokens: 3,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4 },
    },
  }));
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
  const usage = page.waitForResponse((response) => /\/api\/threads\/[^/]+\/usage$/.test(new URL(response.url()).pathname));
  await page.reload();
  expect((await commands).ok()).toBe(true);
  expect((await usage).ok()).toBe(true);
  expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(time);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
}

test("a one-hour cache write waits out the hour before compact is offered", async ({ page }) => {
  await threadWithTurn(page, "claude");
  // Past the five-minute default, the hour the engine reported still holds.
  await returnLater(page, CACHE_MS + 60_000);
  await expect(page.locator(".msg-assistant").last()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
  await returnLater(page, HOUR_MS - 60_000);
  await expect(offer(page)).toHaveCount(0);
  await returnLater(page, HOUR_MS + 60_000);
  await expect(offer(page)).toBeVisible();
});
