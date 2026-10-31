import { useCallback, useLayoutEffect, useRef } from "react";

export const DOCK_ANIMATION_ID = "composer-dock";
export const DOCK_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Plays a move from `from` to where `element`'s anchor sits now. */
function glide(element: HTMLElement, from: DOMRect, to: DOMRect, duration: number): Animation | null {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.hypot(dx, dy) < 0.5) return null;
  const move = element.animate(
    { transform: [`translate3d(${dx}px, ${dy}px, 0)`, "translate3d(0, 0, 0)"] },
    { duration, easing: DOCK_EASING },
  );
  move.id = DOCK_ANIMATION_ID;
  return move;
}

/** Resolves when any composer move in progress has landed. */
export async function composerSettled(): Promise<void> {
  const moves = document.getAnimations?.().filter((move) => move.id === DOCK_ANIMATION_ID) ?? [];
  await Promise.allSettled(moves.map((move) => move.finished));
}

/**
 * The composer moving between its centred and docked places. Layout changes in
 * one commit and a transform plays the difference back, so nothing else moves.
 * Only a position recorded by `recordStart` animates: loading a thread doesn't.
 */
export function useComposerDock(centred: boolean, enabled: boolean, durationMs: number) {
  const mover = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const start = useRef<DOMRect | null>(null);
  const current = useRef<Animation | null>(null);

  const recordStart = useCallback(() => {
    start.current = anchor.current?.getBoundingClientRect() ?? null;
  }, []);

  useLayoutEffect(() => {
    const from = start.current;
    start.current = null;
    current.current?.cancel();
    current.current = null;
    const element = mover.current;
    const target = anchor.current;
    if (enabled && from && element && target && typeof element.animate === "function") {
      current.current = glide(element, from, target.getBoundingClientRect(), durationMs);
    }
  }, [centred, enabled, durationMs]);

  return { mover, anchor, recordStart };
}
