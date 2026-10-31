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
  await expect(page.getByText(/^Reconnecting/)).toBeVisible();
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
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("link", { name: "Back to threads" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
});

test("Escape closes a dialog and returns focus to its opener", async ({ page }) => {
  await page.goto("/#/settings/providers");
  const open = page.getByRole("button", { name: "Update to 2.1.20" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: /^Update / });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
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

test("first run blocks the workspace until setup completes", async ({ page }) => {
  await page.goto("/__mock/scenario/first-run");
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeHidden();
  await page.getByRole("button", { name: "Set up workspace" }).click();
  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible({ timeout: 8000 });
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
  await expect(page.getByText("still", { exact: true })).toBeVisible();
});

test("status loops are stepped and pause when not visible", async ({ page }) => {
  await page.goto("/#/threads/t-approval");
  const dot = page.locator(".sidebar .status-dot").first();
  await expect(dot).toBeVisible();
  const read = () =>
    dot.evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration, state: style.animationPlayState };
    });
  await expect.poll(read).toMatchObject({ name: "dot-breathe", duration: "2s", state: "running" });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(read).toMatchObject({ state: "paused" });
});

test("disclosures animate height over 200 ms", async ({ page }) => {
  await page.goto("/#/threads/t-done");
  const panel = page.locator(".work .collapsible-panel").first();
  await page.getByRole("button", { name: /^Worked for/ }).first().click();
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
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page).toHaveURL(/threads\/t-done/);
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

test("the draft heading keeps its distance from the composer", async ({ page }) => {
  for (const width of [1280, 1728]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/new");
    const heading = await page.locator(".hero-title").boundingBox();
    const composer = await page.locator(".composer-box").boundingBox();
    expect((composer?.y ?? 0) - ((heading?.y ?? 0) + (heading?.height ?? 0))).toBe(49);
  }
});

test("usage opens from the sidebar and closes back to the thread", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/threads/t-done");
  await page.getByRole("link", { name: "Usage" }).click();
  const usage = page.getByRole("dialog", { name: "Usage" });
  await expect(usage.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
  await usage.getByRole("radio", { name: "Limits" }).click();
  await expect(usage.getByText("No engine reports limits.")).toBeVisible();
  await page.keyboard.press("t");
  await usage.getByRole("button", { name: "Close usage" }).click();
  await expect(page).toHaveURL(/threads\/t-done/);
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
  await palette.getByRole("button", { name: /Local folder/ }).click();
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
