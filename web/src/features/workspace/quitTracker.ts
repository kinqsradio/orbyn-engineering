/** How `Cmd+Q` quits the macOS app: at once, after a hold, or on a second press. */
export type QuitMode = "direct" | "hold" | "double_press";

/** The hold, and the fill that shows it, run linearly for this long. */
export const HOLD_MS = 1200;
export const DOUBLE_PRESS_MS = 1500;
/**
 * WebKit often sends no keyup for a letter while Cmd stays down, so a hold is proved
 * by key repeats, not by a missing keyup. The first repeat can take the system's
 * repeat delay; later ones must keep coming.
 */
export const FIRST_REPEAT_MS = 800;
export const REPEAT_GAP_MS = 200;

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
  let aliveTimer: ReturnType<typeof setTimeout> | undefined;
  let againTimer: ReturnType<typeof setTimeout> | undefined;
  let pressedAt: number | null = null;
  const reset = () => {
    clearTimeout(holdTimer);
    clearTimeout(aliveTimer);
    clearTimeout(againTimer);
    holdTimer = aliveTimer = againTimer = undefined;
    pressedAt = null;
    show({ prompt: null });
  };
  /** Calls the hold off unless another repeat arrives within `ms`. */
  const expectRepeat = (ms: number) => {
    clearTimeout(aliveTimer);
    aliveTimer = setTimeout(reset, ms);
  };
  return {
    /** A quit key went down; true when the page took it. */
    down(repeat: boolean, now: number): boolean {
      const current = mode();
      if (current === "direct") return false;
      if (current === "hold") {
        if (holdTimer === undefined) {
          if (repeat) return true;
          show({ prompt: "hold" });
          holdTimer = setTimeout(() => {
            reset();
            quit();
          }, HOLD_MS);
          expectRepeat(FIRST_REPEAT_MS);
        } else if (repeat) {
          expectRepeat(REPEAT_GAP_MS);
        }
        return true;
      }
      if (repeat) return true;
      if (pressedAt !== null && now - pressedAt <= DOUBLE_PRESS_MS) {
        reset();
        quit();
      } else {
        reset();
        pressedAt = now;
        show({ prompt: "again" });
        againTimer = setTimeout(reset, DOUBLE_PRESS_MS);
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
