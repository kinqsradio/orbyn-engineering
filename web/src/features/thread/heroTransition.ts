import { useCallback, useLayoutEffect, useRef } from "react";

export const HERO_TRANSITION_ID = "orbyn-draft-hero-transition";
export const HERO_TRANSITION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Settles once any hero transition has run; the send path waits on this. */
export async function waitForHeroTransition(): Promise<void> {
  if (typeof document.getAnimations !== "function") return;
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.id === HERO_TRANSITION_ID)
      .map((animation) => animation.finished.catch(() => undefined)),
  );
}

/**
 * Moves the composer from the centred draft to its dock with a FLIP Web
 * Animation: only transform changes, so nothing else in the window moves.
 * After upstream's useDraftHeroLayoutTransition.ts (see web/NOTICE), except that
 * only an explicit capture animates, so loading a thread never does.
 */
export function useHeroTransition(hero: boolean, active: boolean, durationMs: number) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const captured = useRef<DOMRect | null>(null);
  const previousHero = useRef(hero);
  const animation = useRef<Animation | null>(null);

  const capture = useCallback(() => {
    captured.current = anchorRef.current?.getBoundingClientRect() ?? null;
  }, []);

  useLayoutEffect(() => {
    const group = groupRef.current;
    const next = anchorRef.current?.getBoundingClientRect() ?? null;
    const changed = previousHero.current !== hero;
    const from = captured.current;
    previousHero.current = hero;
    if (!changed) return;
    captured.current = null;
    animation.current?.cancel();
    animation.current = null;
    if (!active || !group || !from || !next || typeof group.animate !== "function") return;

    const x = from.left - next.left;
    const y = from.top - next.top;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
    const running = group.animate(
      [{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
      { duration: durationMs, easing: HERO_TRANSITION_EASING },
    );
    running.id = HERO_TRANSITION_ID;
    animation.current = running;
  }, [active, durationMs, hero]);

  return { groupRef, anchorRef, capture };
}
