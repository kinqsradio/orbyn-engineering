import { useEffect, useState } from "react";

/** The --m-* durations in tokens.css, in ms, for timers that must match a transition. */
export const MOTION = { fast: 150, baseOut: 140, slow: 300, slowOut: 210, wait: 400 } as const;

/**
 * True once `active` has held for `ms` without a break. Work that finishes inside the wait
 * never shows its loading state, so a fast load doesn't flash a skeleton.
 */
export function useWaited(active: boolean, ms: number = MOTION.wait): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!active) {
      setWaited(false);
      return;
    }
    const timer = setTimeout(() => setWaited(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && waited;
}
