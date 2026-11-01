import { expect, test } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** Rich turns the real service parsed from engine notifications. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("a finished turn folds, groups its tools and shows command output", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:timeline]");
  await expect(page).toHaveURL(/#\/threads\//);
  await settled(service, threadIdOf(page));

  const fold = page.getByRole("button", { name: /^Worked for/ });
  await expect(fold).toBeVisible();
  await expect(page.locator(".msg-assistant").getByText("done")).toBeVisible();
  await expect(page.getByText("I'll look around first.")).toBeHidden();
  await expect(page.getByText("1 file changed")).toBeVisible();

  await fold.click();
  await expect(page.getByText("I'll look around first.")).toBeVisible();
  const group = page.getByRole("button", {
    name: "Ran 2 commands, changed 2 files, and performed 1 other action, tool call failed",
  });
  await group.click();
  await page.getByRole("button", { name: /^cat missing\.txt/ }).click();
  await expect(page.getByText("cat: missing.txt: No such file")).toBeVisible();
  await expect(page.getByText("Exit code 1")).toBeVisible();
  await page.getByRole("button", { name: /^ls -la/ }).click();
  const colored = page.locator(".tool-output span", { hasText: "README.md" });
  await expect(colored).toHaveAttribute("style", /--ansi-green/);

  await page.getByRole("button", { name: "Inspect item" }).first().click();
  const details = page.getByRole("dialog", { name: "Item details" });
  await expect(details).toContainText("exit");
  await page.keyboard.press("Escape");
});

test("a running turn shows its header and streams output; Stop folds it as stopped", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:live]");
  await expect(page.getByRole("status").filter({ hasText: /^Working for/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^Ran 1 command/ }).or(page.locator(".trace-summary").first()).first().click();
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.getByRole("button", { name: /^You stopped after/ })).toBeVisible({ timeout: 15_000 });
});

test("rich Markdown renders: table, math, diagram, links, image and details", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.route("https://example.com/square.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
    }),
  );
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:markdown]");
  await expect(page).toHaveURL(/#\/threads\//);
  await settled(service, threadIdOf(page));

  await expect(page.locator(".md table th").nth(1)).toHaveCSS("text-align", "right");
  await expect(page.getByText("Inline math $e^{i\\pi} + 1 = 0$", { exact: false })).toBeVisible();
  await page.goto(`${service.page}#/settings/chat`);
  await page.getByRole("switch", { name: "Math rendering" }).check();
  await page.goBack();
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(page.locator(".md-math .katex-display")).toBeVisible();
  await expect(page.getByText("costs $5 and $6 to print")).toBeVisible();

  await expect(page.locator(".md-diagram svg")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Expand a square" }).click();
  const box = page.getByRole("dialog", { name: "a square" });
  await box.getByRole("button", { name: "Zoom in" }).click();
  await expect(box.locator("output")).toHaveText("125%");
  await box.getByRole("button", { name: "Close image" }).click();

  await page.getByRole("link", { name: "the docs" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);

  await page.getByRole("button", { name: "More notes" }).click();
  await expect(page.getByText("Hidden detail")).toBeVisible();

  await page.getByRole("button", { name: "the readme" }).click();
  await expect(page.locator(".file-source span[data-line]")).toContainText("# Repo");

  const threadLink = page.getByRole("link", { name: "another thread" });
  await expect(threadLink).toHaveAttribute("href", "#/threads/THREAD");
});

test("a proposed plan shows as a card and can be implemented or saved", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:plan]");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  const card = page.getByRole("region", { name: "Proposed plan" });
  await expect(card.getByText("Tidy the readme")).toBeVisible();
  await expect(card.locator(".plan-card-body")).toHaveAttribute("data-clipped", "true");
  await card.getByRole("button", { name: "Expand plan" }).click();
  await expect(card.getByText("Step 30")).toBeVisible();

  await card.getByRole("button", { name: "Plan actions" }).click();
  await page.getByRole("menuitem", { name: "Save to workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Save plan to workspace" });
  await expect(dialog.getByRole("textbox")).toHaveValue("tidy-the-readme.md");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("status").filter({ hasText: "Plan ready" })).toBeVisible();
  await page.getByRole("button", { name: "Implement plan" }).click();
  await expect(page.getByText("PLEASE IMPLEMENT THIS PLAN:", { exact: false }).first()).toBeVisible();
  await settled(service, id);
});

test("the minimap goes to a prompt and the error banner retries and dismisses", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 500 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:plan] first prompt");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  await send(page, "[scene:failure] second prompt");
  await expect(page.locator(".thread-error")).toContainText("disk full", { timeout: 15_000 });
  await settled(service, id);
  const map = page.getByRole("navigation", { name: "Prompts in this thread" });
  await expect(map.getByRole("button")).toHaveCount(2);
  // No stray ticks over the conversation until the pointer reaches the edge.
  const edge = page.locator(".minimap-zone");
  await expect(edge).toHaveCSS("opacity", "0");
  await edge.hover();
  await expect(edge).toHaveCSS("opacity", "1");
  await map.getByRole("button").first().click();
  await expect(page.locator(".msg-user").first()).toBeInViewport();

  await page.locator(".thread-error").getByRole("button", { name: "Retry" }).click();
  await settled(service, id);
  await expect(page.locator(".msg-user")).toHaveCount(3);
  await page.locator(".thread-error").getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.locator(".thread-error")).toBeHidden();
});

test("changed files list per turn and open the diff; a delegated thread runs on its own", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:timeline]");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  await page.getByRole("button", { name: "1 file changed" }).click();
  await page.getByRole("list", { name: "Changed files" }).getByRole("button").click();
  await expect(page.getByRole("radiogroup", { name: "Diff source" })).toBeVisible();

  const child = await service.api<{ id: string }>("POST", `/api/threads/${id}/delegate`, { prompt: "[scene:usage] help" });
  await page.goto(`${service.page}#/threads/${child.id}`);
  await expect(page.getByText("Runs on its own")).toBeVisible();
  await page.getByRole("button", { name: "Open parent" }).click();
  await expect(page).toHaveURL(new RegExp(id));
});

test("a large turn opens Changes when asked to, and another thread's finish is announced", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`${service.page}#/settings/chat`);
  await page.getByRole("switch", { name: "Open Changes after large turns" }).check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:large]");
  await expect(page).toHaveURL(/#\/threads\//);
  await expect(page.getByRole("radiogroup", { name: "Diff source" })).toBeVisible({ timeout: 15_000 });

  const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
  const other = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: engines[0]?.id,
    model: null,
    title: "Quiet one",
    worktree: null,
    skill_profile: null,
  });
  await expect(page.locator("li[data-thread-item]").filter({ hasText: "Quiet one" })).toBeVisible();
  await service.api("POST", `/api/threads/${other.id}/runs`, { prompt: "[scene:usage] elsewhere" });
  await expect(page.getByRole("status", { name: "Background threads" })).toHaveText(/^Quiet one (finished|failed)$/, { timeout: 20_000 });
});

test("the view follows new output until you scroll up, then offers the way back", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 420 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:plan] one");
  await expect(page).toHaveURL(/#\/threads\//);
  await settled(service, threadIdOf(page));
  await page.getByRole("button", { name: "Expand plan" }).click();
  const log = page.getByRole("log", { name: "Thread messages" });
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect
    .poll(() => log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(80);
});

test("a failed turn keeps its error in view and a command with no output says so", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:failure]");
  await expect(page.getByRole("alert").filter({ hasText: "disk full" })).toBeVisible({ timeout: 15_000 });
  await settled(service, threadIdOf(page));
  await send(page, "[scene:empty]");
  await page.getByRole("button", { name: /^Worked for/ }).last().click();
  await page.getByRole("button", { name: /^true/ }).click();
  await expect(page.getByText("No output.")).toBeVisible();
});

test("a link to a commit here opens it in Diff", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:commitlink]");
  await expect(page).toHaveURL(/#\/threads\//);
  await page.getByRole("link", { name: "this commit" }).click();
  await expect(page.getByRole("radiogroup", { name: "Diff source" }).getByRole("radio", { name: "Commit" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: /commit/i })).toContainText("First");
});
