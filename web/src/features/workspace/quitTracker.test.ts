import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DOUBLE_PRESS_MS, FIRST_REPEAT_MS, HOLD_MS, isQuitKey, quitTracker, REPEAT_GAP_MS, type QuitMode, type QuitState } from "./quitTracker";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function track(mode: QuitMode) {
  const quit = vi.fn();
  const shown: QuitState[] = [];
  const tracker = quitTracker(() => mode, quit, (state) => shown.push(state));
  return { tracker, quit, shown };
}

/** Holds the key: a first press, then repeats every `gap` ms until `until`. */
function hold(tracker: ReturnType<typeof quitTracker>, until: number, gap = 50) {
  tracker.down(false, 0);
  vi.advanceTimersByTime(FIRST_REPEAT_MS - 100);
  for (let at = FIRST_REPEAT_MS - 100; at < until; at += gap) {
    tracker.down(true, at);
    vi.advanceTimersByTime(gap);
  }
}

it("leaves a direct quit to the menu", () => {
  const { tracker, quit } = track("direct");
  expect(tracker.down(false, 0)).toBe(false);
  expect(quit).not.toHaveBeenCalled();
});

it("quits once key repeats have kept coming for the full hold", () => {
  const { tracker, quit, shown } = track("hold");
  hold(tracker, HOLD_MS + 50);
  expect(quit).toHaveBeenCalledTimes(1);
  expect(shown.at(-1)).toEqual({ prompt: null });
});

it("treats a tap with Cmd still down as no hold, even without a keyup", () => {
  const { tracker, quit, shown } = track("hold");
  tracker.down(false, 0);
  expect(shown.at(-1)).toEqual({ prompt: "hold" });
  vi.advanceTimersByTime(HOLD_MS * 2);
  expect(quit).not.toHaveBeenCalled();
  expect(shown.at(-1)).toEqual({ prompt: null });
});

it("calls the hold off when repeats stop or the key comes up", () => {
  const { tracker, quit } = track("hold");
  tracker.down(false, 0);
  vi.advanceTimersByTime(FIRST_REPEAT_MS - 100);
  tracker.down(true, FIRST_REPEAT_MS - 100);
  vi.advanceTimersByTime(REPEAT_GAP_MS + 1);
  vi.advanceTimersByTime(HOLD_MS);
  expect(quit).not.toHaveBeenCalled();
  tracker.down(false, 5000);
  vi.advanceTimersByTime(100);
  tracker.up();
  vi.advanceTimersByTime(HOLD_MS);
  expect(quit).not.toHaveBeenCalled();
});

it("quits on a second press inside the window, and a late one starts over", () => {
  const start = 10_000;
  const late = track("double_press");
  late.tracker.down(false, start);
  expect(late.shown.at(-1)).toEqual({ prompt: "again" });
  late.tracker.down(true, start + 50);
  late.tracker.down(false, start + DOUBLE_PRESS_MS + 1);
  expect(late.quit).not.toHaveBeenCalled();
  const inside = track("double_press");
  inside.tracker.down(false, start);
  inside.tracker.down(false, start + DOUBLE_PRESS_MS - 1);
  expect(inside.quit).toHaveBeenCalledTimes(1);
});

it("matches Cmd+Q only", () => {
  expect(isQuitKey(new KeyboardEvent("keydown", { key: "q", metaKey: true }))).toBe(true);
  expect(isQuitKey(new KeyboardEvent("keydown", { key: "Q", metaKey: true, shiftKey: true }))).toBe(false);
  expect(isQuitKey(new KeyboardEvent("keydown", { key: "q", ctrlKey: true }))).toBe(false);
});
