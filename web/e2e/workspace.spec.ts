import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/__mock/scenario/default");
});

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
  [320, 740],
]) {
  test(`no page overflow at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    for (const hash of ["#/threads/t-done", "#/new", "#/settings/projects", "#/settings/providers"]) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() =>
        Math.max(
          ...[document.documentElement, ...document.querySelectorAll<HTMLElement>(".main, .transcript, .settings-main")].map(
            (element) => element.scrollWidth - element.clientWidth,
          ),
        ),
      );
      expect(overflow, hash).toBe(0);
    }
  });
}

test("token moves out of the URL", async ({ page }) => {
  await page.goto("/?token=abc#/");
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  expect(page.url()).not.toContain("token");
  expect(await page.evaluate(() => sessionStorage.getItem("orbyn.token"))).toBe("abc");
});

test("a dropped stream shows reconnecting and loses nothing", async ({ page }) => {
  await page.goto("/#/threads/t-empty");
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill("stream please");
  await box.press("Enter");
  await expect(page.getByText(/^Work(ed|ing) for/)).toBeVisible();
  await page.evaluate(() => fetch("/__mock/drop-streams"));
  // A stream that cannot reconnect is the service not answering: the header says Paused and the composer carries the banner.
  await expect(page.getByRole("status").filter({ hasText: "Can’t reach the Orbyn service" })).toBeVisible();
  await expect(page.locator(".thread-state")).toHaveText("Completed", { timeout: 10_000 });
  await expect(page.locator(".msg-assistant")).toContainText("Stop the run with Cancel, or wait for it to finish.");
});

test("the terminal connects and sizes itself without WebGL", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(page.locator(".terminal-panel .pill")).toHaveText("Connected");
  await expect(page.locator(".xterm-rows")).toContainText("resized to");
  expect(await page.locator(".xterm canvas").count()).toBe(0);
});

test("narrow layout is one surface with a way back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("link", { name: /Explain how the event log/ }).click();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeHidden();
  await page.getByRole("button", { name: "Details" }).click();
  await page.getByRole("button", { name: /^Changes/ }).click();
  await expect(page.getByRole("tablist", { name: "Context" })).toBeVisible();
  await page.getByRole("button", { name: "Back to thread" }).click();
  await page.getByRole("link", { name: "Back to threads" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
});

test("Escape closes a dialog and returns focus to its opener", async ({ page }) => {
  await page.goto("/#/settings/providers");
  const open = page.getByRole("button", { name: /^Updates available/ });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Update everything" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
});

test("keyboard focus is visible and reduced motion stops animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/threads/t-approval");
  await expect(page.locator(".thread-state")).toContainText("Approval");
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
  expect(outline).toBe("solid");
  const duration = await page.evaluate(() => getComputedStyle(document.querySelector(".spin") as Element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.01);
});

test("first run opens on the draft flow with nothing to set up", async ({ page }) => {
  await page.goto("/__mock/scenario/first-run");
  // The welcome steps open first and are never a gate: one click leaves them for the draft flow.
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Add your first project" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await expect(page.getByText(/set up/i)).toHaveCount(0);
});

test("unavailable skills get a quiet line, never a blocking screen", async ({ page }) => {
  await page.goto("/__mock/scenario/no-skills");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Add your first project" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Skills aren't available right now" })).toBeVisible();
  // The empty home no longer offers a project-less start; its draft is still the scratch route.
  await page.evaluate(() => (location.hash = "#/new/scratch"));
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
});

const openHero = async (page: Page, animationMs: number) => {
  await page.addInitScript(
    (ms) => localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ panelAnimationMs: ms })),
    animationMs,
  );
  await page.goto("/__mock/scenario/default?to=/%23/threads/t-empty");
  await expect(page.getByRole("heading", { name: /What should we build/ })).toBeVisible();
};

const send = async (page: Page, text: string) => {
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.fill(text);
  await box.press("Enter");
};

test("the composer travels with upstream's easing and holds the send until it lands", async ({ page }) => {
  await openHero(page, 240);
  const start = page.locator(".composer-box").boundingBox();
  const startBox = await start;
  let posted = false;
  page.on("request", (request) => {
    if (request.url().includes("/runs")) posted = true;
  });
  await send(page, "travel");
  const timing = await page.evaluate(() => {
    const animation = document.getAnimations().find((a) => a.id === "composer-dock");
    if (!animation) return null;
    animation.pause();
    const effect = animation.effect?.getComputedTiming();
    const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
    return { duration: effect?.duration, easing: effect?.easing, from: keyframes[0]?.transform, properties: Object.keys(keyframes[0] ?? {}) };
  });
  expect(timing?.duration).toBe(240);
  expect(timing?.easing).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
  expect(timing?.from).toContain("translate3d(0px,");
  expect(timing?.properties).not.toContain("width");
  await page.waitForTimeout(150);
  expect(posted).toBe(false);
  await page.evaluate(() => document.getAnimations().find((a) => a.id === "composer-dock")?.finish());
  await expect.poll(() => posted).toBe(true);
  const end = await page.locator(".composer-box").boundingBox();
  expect(end!.y).toBeGreaterThan(startBox!.y + 100);
});

test("the default zero duration and reduced motion skip the transition", async ({ page }) => {
  await openHero(page, 0);
  await send(page, "instant");
  expect(await page.evaluate(() => document.getAnimations().some((a) => a.id === "composer-dock"))).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ panelAnimationMs: 240 })));
  await page.goto("/__mock/scenario/default?to=/%23/threads/t-empty");
  await expect(page.getByRole("heading", { name: /What should we build/ })).toBeVisible();
  await send(page, "still");
  expect(await page.evaluate(() => document.getAnimations().some((a) => a.id === "composer-dock"))).toBe(false);
  await expect(page.locator(".msg-user").getByText("still", { exact: true })).toBeVisible();
});

test("status dots are static and the spinner is the only loop, 900 ms linear", async ({ page }) => {
  await page.goto("/#/threads/t-approval");
  const dot = page.locator(".sidebar .status-dot").first();
  await expect(dot).toBeVisible();
  const read = (locator: typeof dot) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const after = getComputedStyle(element, "::after");
      return { name: style.animationName, after: after.animationName, duration: style.animationDuration, easing: style.animationTimingFunction };
    });
  expect(await read(dot)).toMatchObject({ name: "none", after: "none" });
  const spin = page.locator(".spin").first();
  await expect(spin).toBeAttached();
  expect(await read(spin)).toMatchObject({ name: "spin", duration: "0.9s", easing: "linear" });
});

const contextMotion = (page: Page) =>
  page.evaluate(() => {
    const t = document.getAnimations().find((a) => a instanceof CSSTransition && (a.effect as KeyframeEffect).target?.matches(".context"));
    const timing = t?.effect?.getComputedTiming();
    return t ? { property: (t as CSSTransition).transitionProperty, duration: timing?.duration, easing: timing?.easing } : null;
  });

test("the side panel does not move when the page loads with it open", async ({ page }) => {
  // An extra-wide window opens the panel by default.
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.goto("/__mock/scenario/default?to=/%23/threads/t-done");
  await expect(page.getByRole("complementary", { name: "Thread context" })).toBeVisible();
  expect(await contextMotion(page)).toBeNull();
});

test("the side panel slides in over 300 ms ease-out and out over 210 ms ease-in-out", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.addInitScript(() => localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ panelOpen: false })));
  await page.goto("/__mock/scenario/default?to=/%23/threads/t-done");
  const panel = page.getByRole("complementary", { name: "Thread context" });
  await expect(page.getByRole("heading", { name: "Explain how the event log resumes" })).toBeVisible();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Show side panel" }).click();
  await expect(panel).toBeVisible();
  expect(await contextMotion(page)).toEqual({ property: "translate", duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  await page.getByRole("button", { name: "Close side panel" }).click();
  expect(await contextMotion(page)).toEqual({ property: "translate", duration: 210, easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
  await expect(panel).toBeHidden();
});

test("disclosures animate height over 200 ms", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  const panel = page.locator(".work .collapsible-panel").first();
  await page.locator(".work-summary[aria-expanded]").first().click();
  const transition = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  });
  expect(transition).toEqual({ property: "height", duration: "0.2s" });
  await expect(page.locator(".work .trace").first()).toBeVisible();
});

test("settings float over the workspace and close back to it", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  await expect(page.getByRole("heading", { name: "Explain how the event log resumes" })).toBeVisible();
  const opener = page.getByRole("link", { name: "Settings" });
  await opener.click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page).toHaveURL(/threads\/t-done/);
  // Closing returns focus to what opened it.
  await expect(opener).toBeFocused();
  // Escape closes from anywhere on the page, not only from inside it.
  await opener.click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await page.locator(".settings-side").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Settings" })).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the sidebar rail resizes and remembers", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  const rail = page.getByRole("separator", { name: "Resize sidebar" });
  const box = await rail.boundingBox();
  await page.mouse.move(box!.x + 8, 300);
  await page.mouse.down();
  await page.mouse.move(300, 300);
  await page.mouse.up();
  await expect.poll(async () => (await page.locator(".sidebar").boundingBox())?.width).toBe(300);
  await page.reload();
  await expect.poll(async () => (await page.locator(".sidebar").boundingBox())?.width).toBe(300);
});

test("code blocks get a language header and highlighted tokens", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  await expect(page.locator(".code-lang").first()).toHaveText("rust");
  await expect(page.locator(".code-card code span[style]").first()).toBeAttached();
});

test("the draft docks its composer at the bottom with the heading above it", async ({ page }) => {
  for (const width of [1280, 1728]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/new");
    const heading = await page.locator(".hero-title").boundingBox();
    const composer = await page.locator(".composer-box").boundingBox();
    expect((heading?.y ?? 0) + (heading?.height ?? 0)).toBeLessThan(composer?.y ?? 0);
    expect(900 - ((composer?.y ?? 0) + (composer?.height ?? 0))).toBeLessThan(80);
  }
});

test("usage opens from the sidebar as a page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/threads/t-done");
  await page.getByRole("link", { name: "Usage" }).click();
  const usage = page.getByRole("region", { name: "Usage" });
  await expect(usage.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
  await usage.getByRole("tab", { name: "Usage" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(usage.getByRole("tab", { name: "Limits" })).toHaveAttribute("aria-selected", "true");
  await expect(usage.getByText("No engine reports limits.")).toBeVisible();
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/#\/usage/);
});

test("the draft keeps its text and files through a project switch and adding a folder", async ({ page }) => {
  await page.goto("/#/new");
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("Keep this");
  await page.getByLabel("Attach files").first().setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await page.locator(".hero-project").click();
  const search = page.getByRole("textbox", { name: "Search projects" });
  await search.fill("market");
  await search.press("Enter");
  await expect(page.locator(".hero-project")).toHaveText("marketing-site");
  await expect(message).toHaveValue("Keep this");

  await page.locator(".hero-project").click();
  await page.getByRole("option", { name: "Add project" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Folder path").fill("/Users/dev/code/fresh-folder");
  await palette.getByLabel("Folder path").press("Enter");
  await page.getByRole("button", { name: "Trust folder" }).click();
  await expect(page.locator(".hero-project")).toHaveText("fresh-folder");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this");
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("notes.txt");
});

test("New thread in opens a draft in the chosen project", async ({ page }) => {
  await page.goto("/#/new");
  await expect(page.locator(".hero-project")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("button", { name: "New thread in..." }).click();
  await palette.getByRole("button", { name: "marketing-site" }).click();
  await expect(page.locator(".hero-project")).toHaveText("marketing-site");
});

test("the pull requests page lists and filters", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  await page.getByRole("link", { name: "Pull requests" }).click();
  await expect(page.getByRole("heading", { name: "Pull requests", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add approval timeouts/ })).toBeVisible();
  await page.getByLabel("Search pull requests").fill("label:nothing ");
  await expect(page.getByText("No pull requests match")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("button", { name: /Add approval timeouts/ })).toBeVisible();

  // With a project chosen, the empty state names it.
  await page.getByRole("button", { name: "All projects" }).click();
  await page.getByRole("menuitemradio", { name: /^(?!All projects)/ }).first().click();
  await page.getByLabel("Search pull requests").fill("label:nothing ");
  await expect(page.getByText(/^No pull requests in .+ match these filters\.$/)).toBeVisible();
});

test("Reading folds the sidebar away on a wide window, but a narrow home is still the thread list", async ({ page }) => {
  const reading = () =>
    page.addInitScript(() => {
      localStorage.setItem("orbyn.prefs.migrated", "1");
      localStorage.setItem("orbyn.prefs.v1", JSON.stringify({ workspaceLayout: "reading" }));
    });
  await reading();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#/");
  // The mock scenario already loaded the app at this address, so the init script needs a fresh load.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-workspace", "reading");
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "New thread", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/#/threads/t-done");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  const toggle = page.getByRole("button", { name: "Show sidebar" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.locator(".sidebar a").first().focus();
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeFocused();
});

test("the panel shows all six tabs at 380px, and the arrow keys move between them", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/__mock/scenario/default?to=/%23/threads/t-done");
  await page.getByRole("button", { name: "Show side panel" }).click();
  await page.getByRole("tab", { name: "Files" }).click();
  const row = page.getByRole("tablist", { name: "Context" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("tab")).toHaveText(["Diff", "Files", "Browser", "Activity", "PRs", "Side chat"]);
  const m = await row.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, o: e.hasAttribute("data-overflow"), w: e.closest(".context")!.getBoundingClientRect().width }));
  expect(m.w).toBe(380);
  expect(m.sw).toBeLessThanOrEqual(m.cw);
  expect(m.o).toBe(false);
  // Nothing is folded into More, and with no tab closed there is no "+" either.
  await expect(page.getByRole("button", { name: "More tabs" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open a tab" })).toHaveCount(0);
  // One tab stop: the chosen tab. The arrows move the choice, and End and Home reach the ends.
  const files = page.getByRole("tab", { name: "Files" });
  await expect(files).toHaveAttribute("aria-selected", "true");
  await files.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Browser" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Side chat" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
});
