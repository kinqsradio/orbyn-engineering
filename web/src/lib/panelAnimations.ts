import { useEffect, useRef, useState } from "react";
import { useUi } from "../state/ui";
import { usePrefersReducedMotion } from "./useLayout";

export const MAX_PANEL_ANIMATION_MS = 400;

/** Panel motion is opt-in: 0 ms by default, and reduced motion always wins. */
export function usePanelMotion(): { enabled: boolean; durationMs: number } {
  const durationMs = useUi((state) => state.panelAnimationMs);
  const reduced = usePrefersReducedMotion();
  return { enabled: durationMs > 0 && !reduced, durationMs };
}

/**
 * Publishes the setting on <html> for the stylesheet. It goes quiet across a
 * route change for two frames, so a pane mounting with the new route stays still.
 */
export function usePanelMotionRoot(routeKey: string): void {
  const { enabled, durationMs } = usePanelMotion();
  const [settledRoute, setSettledRoute] = useState<string | null>(null);

  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setSettledRoute(routeKey));
    });
    return () => cancelAnimationFrame(frame);
  }, [routeKey]);

  const on = enabled && settledRoute === routeKey;
  useEffect(() => {
    const { dataset, style } = document.documentElement;
    dataset.panelMotion = on ? "on" : "off";
    style.setProperty("--panel-duration", `${durationMs}ms`);
  }, [on, durationMs]);
}

/** Stays true for `exitMs` after `open` drops, so a closing pane can animate out. */
export function useLingering(open: boolean, exitMs: number): boolean {
  const [lingering, setLingering] = useState(false);
  const wasOpen = useRef(open);

  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed || exitMs === 0) {
      setLingering(false);
      return;
    }
    setLingering(true);
    const timer = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);

  return open || lingering;
}
