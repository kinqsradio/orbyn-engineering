import { useEffect, useState } from "react";
import { useUi } from "../state/ui";
import { MOTION } from "./motion";
import { usePrefersReducedMotion } from "./useLayout";

export const MAX_PANEL_ANIMATION_MS = 400;

/**
 * `enabled` is full motion, which the composer's travel uses and reduced motion turns off.
 * `panels` stays on under reduced motion, where the stylesheet swaps the slide for a fade.
 * `exitMs` is how long a closing pane stays mounted to finish leaving.
 */
export function usePanelMotion(): { enabled: boolean; panels: boolean; durationMs: number; exitMs: number } {
  const durationMs = useUi((state) => state.panelAnimationMs);
  const reduced = usePrefersReducedMotion();
  const panels = durationMs > 0;
  return {
    enabled: panels && !reduced,
    panels,
    durationMs,
    exitMs: !panels ? 0 : reduced ? MOTION.fast : MOTION.slowOut,
  };
}

/**
 * True two frames after `key` becomes non-null, and false again when it changes. A pane
 * that was already there when its page loaded stays still; only later opens and closes move.
 */
export function useSettledAfter(key: string | null): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setSettled(key));
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);
  return key !== null && settled === key;
}

/**
 * Publishes the setting on <html> for the stylesheet. It goes quiet across a
 * route change for two frames, so a pane mounting with the new route stays still.
 */
export function usePanelMotionRoot(routeKey: string): void {
  const { panels, durationMs } = usePanelMotion();
  const settled = useSettledAfter(routeKey);

  const on = panels && settled;
  useEffect(() => {
    const { dataset, style } = document.documentElement;
    dataset.panelMotion = on ? "on" : "off";
    // The default is the --panel-duration token; only a different setting overrides it.
    if (durationMs === MOTION.slow) style.removeProperty("--panel-duration");
    else style.setProperty("--panel-duration", `${durationMs}ms`);
  }, [on, durationMs]);
}

/**
 * Stays true for `exitMs` after `open` drops, so a closing pane can animate out. The change
 * is taken while rendering, so the pane never unmounts for a frame between closing and lingering.
 */
export function useLingering(open: boolean, exitMs: number): boolean {
  const [lingering, setLingering] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLingering(!open && exitMs > 0);
  }

  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(timer);
  }, [lingering, exitMs]);

  return open || lingering;
}
