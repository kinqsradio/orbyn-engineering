import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DOUBLE_PRESS_MS, HOLD_MS, isQuitKey, quitTracker, type QuitMode, type QuitState } from "./quitTracker";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function track(mode: QuitMode) {
  const quit = vi.fn();
  const shown: QuitState[] = [];
  const tracker = quitTracker(() => mode, quit, (state) => shown.push(state));
  return { tracker, quit, shown };
}

it("leaves a direct quit to the menu", () => {
  const { tracker, quit } = track("direct");
  expect(tracker.down(false, 0)).toBe(false);
  expect(quit).not.toHaveBeenCalled();
});

it("quits only after the key is held for the full time", () => {
  const { tracker, quit, shown } = track("hold");
  expect(tracker.down(false, 0)).toBe(true);
  expect(shown.at(-1)).toEqual({ prompt: "hold" });
  vi.advanceTimersByTime(HOLD_MS / 2);
  tracker.up();
  vi.advanceTimersByTime(HOLD_MS);
  expect(quit).not.toHaveBeenCalled();
  expect(shown.at(-1)).toEqual({ prompt: null });
  tracker.down(false, 0);
  tracker.down(true, 10);
  vi.advanceTimersByTime(HOLD_MS);
  expect(quit).toHaveBeenCalledTimes(1);
});

it("quits on a second press in time, and a late one starts over", () => {
  const { tracker, quit, shown } = track("double_press");
  tracker.down(false, 0);
  expect(shown.at(-1)).toEqual({ prompt: "again" });
  tracker.down(true, 50);
  expect(quit).not.toHaveBeenCalled();
  tracker.down(false, DOUBLE_PRESS_MS + 1);
  expect(quit).not.toHaveBeenCalled();
  tracker.down(false, DOUBLE_PRESS_MS + 200);
  expect(quit).toHaveBeenCalledTimes(1);
});

it("matches Cmd+Q only", () => {
  expect(isQuitKey(new KeyboardEvent("keydown", { key: "q", metaKey: true }))).toBe(true);
  expect(isQuitKey(new KeyboardEvent("keydown", { key: "Q", metaKey: true, shiftKey: true }))).toBe(false);
  expect(isQuitKey(new KeyboardEvent("keydown", { key: "q", ctrlKey: true }))).toBe(false);
});
