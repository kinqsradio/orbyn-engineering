import { useEffect, useState } from "react";
import { useUi } from "../state/ui";
import { usePrefersReducedMotion } from "./useLayout";

export const MAX_PANEL_ANIMATION_MS = 400;

/**
 * Panel motion is off at 0 ms, upstream's default: animating a panel's width
 * costs layout on every frame. Reduced motion always wins.
 */
export function usePanelAnimations(): { active: boolean; durationMs: number } {
  const durationMs = useUi((state) => state.panelAnimationMs);
  const reduced = usePrefersReducedMotion();
  return { active: durationMs > 0 && !reduced, durationMs };
}

/**
 * Mirrors the setting onto <html> for CSS. Held off for two frames after a route
 * change, so a pane that mounts with the new route doesn't animate in.
 */
export function usePanelAnimationAttribute(routeKey: string): void {
  const { active, durationMs } = usePanelAnimations();
  const [paintedKey, setPaintedKey] = useState<string | null>(null);
  const suppressed = paintedKey !== routeKey;

  useEffect(() => {
    if (!suppressed) return;
    let release = 0;
    const paint = requestAnimationFrame(() => {
      release = requestAnimationFrame(() => setPaintedKey(routeKey));
    });
    return () => {
      cancelAnimationFrame(paint);
      cancelAnimationFrame(release);
    };
  }, [routeKey, suppressed]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.panelAnimations = String(active && !suppressed);
    root.style.setProperty("--panel-animation-duration", `${durationMs}ms`);
  }, [active, durationMs, suppressed]);
}

/** Keeps a closing panel mounted for its exit, then lets it go. */
export function usePanelPresence(open: boolean, animated: boolean, durationMs: number): boolean {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  if (!open && !animated && present) setPresent(false);

  useEffect(() => {
    if (open || !animated) return;
    const timer = setTimeout(() => setPresent(false), durationMs);
    return () => clearTimeout(timer);
  }, [animated, durationMs, open]);

  return open || (animated && present);
}
