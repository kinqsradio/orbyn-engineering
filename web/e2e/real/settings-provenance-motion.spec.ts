//! Real disclosure motion must clip content without becoming a hidden scroll owner.
import { expect, test } from "@playwright/test";
import { startProject } from "./service";

test("opening Advanced cannot scroll its panel before provenance opens", async ({ page }, info) => {
  const { service, projectId } = await startProject();
  try {
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { branch_name_prefix: "fixture" } });
    await page.clock.install({ time: new Date("2026-11-02T08:00:00Z") });
    await page.goto(`${service.page}#/settings/worktrees`);
    const row = page.locator("#worktrees-branch-prefix");
    const panel = page.locator(".collapsible-panel").filter({ has: row });
    const advanced = panel.locator("..").getByRole("button", { name: "Advanced", exact: true });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(advanced).toBeEnabled();
    // Freeze timers so Collapsible's real 200ms cleanup cannot replace its height
    // while the browser's actual height transition is sampled in mid-flight.
    await page.clock.pauseAt(new Date("2026-11-02T09:00:00Z"));
    await advanced.click();
    const measured = await panel.evaluate((element) => {
      const node = element as HTMLElement;
      node.getBoundingClientRect();
      const transition = node.getAnimations().find((animation) => animation instanceof CSSTransition && animation.transitionProperty === "height");
      if (!transition) throw new Error("Expected the existing height transition");
      const duration = transition.effect?.getComputedTiming().duration;
      if (typeof duration !== "number" || duration !== 200) throw new Error("Expected unmodified 200ms disclosure motion");
      transition.pause(); transition.currentTime = duration * 0.35;
      const button = node.querySelector<HTMLButtonElement>("#worktrees-branch-prefix button[aria-haspopup=dialog]");
      if (!button) throw new Error("Expected the actual provenance trigger");
      node.scrollTop = 0;
      const beforeY = button.getBoundingClientRect().y;
      button.focus();
      const focusedScroll = node.scrollTop;
      node.scrollTop = node.scrollHeight;
      return { duration, height: node.clientHeight, contentHeight: node.scrollHeight,
        overflow: getComputedStyle(node).overflowY, focused: document.activeElement === button,
        focusedScroll, scrollTop: node.scrollTop, beforeY, afterY: button.getBoundingClientRect().y };
    });
    await info.attach("partial-disclosure-geometry", { body: JSON.stringify(measured), contentType: "application/json" });
    expect(measured.height).toBeGreaterThan(0); expect(measured.height).toBeLessThan(measured.contentHeight);
    expect(measured.focused).toBe(true);
    expect(measured.focusedScroll, "focusing a control must not scroll its disclosure").toBe(0);
    expect(measured.scrollTop, "a clipped disclosure must not internally scroll and move its controls").toBe(0);
    await panel.evaluate((element) => { for (const animation of element.getAnimations()) animation.play(); });
    await page.clock.runFor(250);
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await row.getByRole("button", { name: /Show where this value comes from/ }).click();
    const popup = row.getByRole("dialog", { name: "Branch prefix", exact: true });
    await expect(popup).toBeVisible(); await expect(popup.getByText("Overridden by", { exact: true })).toBeVisible();
    const visible = await popup.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { position: getComputedStyle(element).position, withinViewport: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
        receivesPointer: hit !== null && element.contains(hit) };
    });
    expect(visible).toEqual({ position: "fixed", withinViewport: true, receivesPointer: true });
    await page.screenshot({ path: info.outputPath("provenance-after-disclosure.png") });
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(row.getByRole("button", { name: /Show where this value comes from/ })).toBeFocused();
  } finally { await service.stop(); }
});
