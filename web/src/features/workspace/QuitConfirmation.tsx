import { useEffect, useRef, useState } from "react";
import { api, request } from "../../api/client";
import { inDesktopApp, readShellStatus } from "../../api/shell";
import type { PreferenceView } from "../../api/types";
import { useUi } from "../../state/ui";
import { HOLD_MS, isQuitKey, quitTracker, type QuitMode, type QuitState } from "./quitTracker";

const MODES: readonly QuitMode[] = ["direct", "hold", "double_press"];

/**
 * In the macOS desktop app, `Cmd+Q` is the page's when quitting needs a hold or a
 * second press; the menu keeps it only for a direct quit.
 */
export function QuitConfirmation() {
  const [state, setState] = useState<QuitState>({ prompt: null });
  const mode = useRef<QuitMode>("direct");
  const pushToast = useUi((ui) => ui.pushToast);

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
    return () => {
      live = false;
      tracker.stop();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", tracker.stop);
      window.removeEventListener("focus", refresh);
    };
  }, [pushToast]);

  if (!state.prompt) return null;
  return (
    <div className="quit-overlay" role="status" aria-live="assertive">
      {state.prompt === "hold" ? (
        <>
          Hold ⌘Q to quit
          <span className="quit-progress" style={{ animationDuration: `${HOLD_MS}ms` }} aria-hidden />
        </>
      ) : (
        "Press ⌘Q again to quit"
      )}
    </div>
  );
}
