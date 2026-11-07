import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useCommand } from "../../app/shortcuts";
import { api, request } from "../../api/client";
import { inDesktopApp, readShellStatus } from "../../api/shell";
import type { PreferenceView } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { HOLD_MS, isQuitKey, quitTracker, type QuitMode, type QuitState } from "./quitTracker";

const MODES: readonly QuitMode[] = ["direct", "hold", "double_press"];
const RELOAD_EVENT = "orbyn:quit-confirmation";

/**
 * In the macOS desktop app, `Cmd+Q` is the page's when quitting needs a hold or a
 * second press; the menu keeps it only for a direct quit.
 */
export function QuitConfirmation() {
  const [state, setState] = useState<QuitState>({ prompt: null });
  const mode = useRef<QuitMode>("direct");
  const pushToast = useUi((ui) => ui.pushToast);
  // Counted from the threads the sidebar has loaded; there is no separate running-agent feed.
  const working = useWorkspace((state) => Object.values(state.threads).filter((thread) => thread.active_run).length);
  // Settings saves the mode in this window; read it again at once rather than on focus.
  useCommand("quitConfirmation.reload", () => {
    window.dispatchEvent(new Event(RELOAD_EVENT));
  });

  useEffect(() => {
    let live = true;
    let ready = false;
    const read = async () => {
      const [info, preferences] = await Promise.all([
        api.info(),
        request<PreferenceView[]>("GET", "/api/preferences"),
        inDesktopApp() ? Promise.resolve() : readShellStatus().then(() => undefined),
      ]);
      const value = preferences.find((view) => view.key === "quit_confirmation")?.value;
      if (!live) return;
      ready = info.platform === "macos" && inDesktopApp();
      mode.current = ready && MODES.includes(value as QuitMode) ? (value as QuitMode) : "direct";
    };
    void read().catch(() => undefined);
    const tracker = quitTracker(
      () => mode.current,
      () => void api.shellAction("quit").catch(() => pushToast("Couldn't quit the app.")),
      setState,
    );
    const down = (event: KeyboardEvent) => {
      if (!ready || !isQuitKey(event)) return;
      if (tracker.down(event.repeat, Date.now())) event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key.toLowerCase() === "q") tracker.up();
    };
    // The setting changes in Settings; reading it again on focus keeps the key in step.
    const refresh = () => void read().catch(() => undefined);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", tracker.stop);
    window.addEventListener("focus", refresh);
    window.addEventListener(RELOAD_EVENT, refresh);
    return () => {
      window.removeEventListener(RELOAD_EVENT, refresh);
      live = false;
      tracker.stop();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", tracker.stop);
      window.removeEventListener("focus", refresh);
    };
  }, [pushToast]);

  // The bar fills linearly while the key is held. A release before the end lets the overlay
  // stay for the short reset, so the bar visibly runs back to empty.
  const holding = state.prompt === "hold";
  const [fill, setFill] = useState<"idle" | "holding" | "releasing">("idle");
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!holding) {
      setFill((current) => (current === "holding" ? "releasing" : "idle"));
      return;
    }
    const frame = requestAnimationFrame(() => setFill("holding"));
    return () => cancelAnimationFrame(frame);
  }, [holding]);
  useEffect(() => {
    if (fill !== "releasing") return;
    const seconds = bar.current ? Number.parseFloat(getComputedStyle(bar.current).transitionDuration) : 0;
    const timer = setTimeout(() => setFill("idle"), Number.isFinite(seconds) ? seconds * 1000 : 0);
    return () => clearTimeout(timer);
  }, [fill]);

  const prompt = state.prompt ?? (fill === "releasing" ? "hold" : null);
  if (!prompt) return null;
  const agents = `${working} ${working === 1 ? "agent is" : "agents are"} working`;
  const holdNote = `${working > 0 ? `${agents}. ` : ""}Keep holding ⌘Q.`;
  const againNote = working > 0 ? `${agents} and will stop.` : null;
  return (
    <div className="quit-overlay" role="status" aria-live="assertive">
      <kbd className="quit-key">⌘ Q</kbd>
      {prompt === "hold" ? (
        <>
          <b>Hold to quit</b>
          <span className="quit-note">{holdNote}</span>
          <span
            ref={bar}
            className="quit-progress"
            data-holding={fill === "holding" || undefined}
            style={{ "--hold-ms": `${HOLD_MS}ms` } as CSSProperties}
            aria-hidden
          />
        </>
      ) : (
        <>
          <b>Press ⌘Q again to quit</b>
          {againNote ? <span className="quit-note">{againNote}</span> : null}
        </>
      )}
    </div>
  );
}
