/** How `Cmd+Q` quits the macOS app: at once, after a hold, or on a second press. */
export type QuitMode = "direct" | "hold" | "double_press";

export const HOLD_MS = 1000;
export const DOUBLE_PRESS_MS = 1500;

export const isQuitKey = (event: KeyboardEvent) =>
  event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "q";

export interface QuitState {
  /** What the overlay says, or null when it is hidden. */
  prompt: "hold" | "again" | null;
}

/**
 * The confirmation's clock, apart from the DOM so it can be tested. `quit` runs once
 * the mode is satisfied; `show` tells the overlay what to say.
 */
export function quitTracker(mode: () => QuitMode, quit: () => void, show: (state: QuitState) => void) {
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let pressedAt = 0;
  const reset = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    show({ prompt: null });
  };
  return {
    /** A quit key went down; true when the page took it. */
    down(repeat: boolean, now: number): boolean {
      const current = mode();
      if (current === "direct") return false;
      if (current === "hold") {
        if (holdTimer === undefined && !repeat) {
          show({ prompt: "hold" });
          holdTimer = setTimeout(() => {
            holdTimer = undefined;
            show({ prompt: null });
            quit();
          }, HOLD_MS);
        }
        return true;
      }
      if (repeat) return true;
      if (pressedAt > 0 && now - pressedAt <= DOUBLE_PRESS_MS) {
        pressedAt = 0;
        reset();
        quit();
      } else {
        pressedAt = now;
        show({ prompt: "again" });
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
          holdTimer = undefined;
          pressedAt = 0;
          show({ prompt: null });
        }, DOUBLE_PRESS_MS);
      }
      return true;
    },
    /** Q or Cmd came up: a hold that hasn't finished is called off. */
    up() {
      if (mode() === "hold") reset();
    },
    stop: reset,
  };
}
