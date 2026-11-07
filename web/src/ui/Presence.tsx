import { cloneElement, Fragment, isValidElement, useState, type ReactElement } from "react";
import { useLingering } from "../lib/panelAnimations";
import { MOTION } from "../lib/motion";
import { usePrefersReducedMotion } from "../lib/useLayout";

type Closable = ReactElement<{ closing?: boolean }>;

/**
 * What a surface that is leaving carries: it takes no focus or pointer at once, is hidden from
 * assistive technology, and `data-closing` lets the stylesheet fade it out.
 */
export function closingProps(closing: boolean | undefined) {
  return closing ? ({ inert: true, "aria-hidden": true, "data-closing": "" } as const) : {};
}

/** How long a menu or dialog stays mounted to fade out: --m-base-out, or --m-fast under reduced motion. */
export function useExitMs(): number {
  return usePrefersReducedMotion() ? MOTION.fast : MOTION.baseOut;
}

/**
 * Keeps a surface mounted while it fades out. Wrap the conditional element,
 * `<Presence>{open ? <Menu … /> : null}</Presence>`: when it goes away the last element stays
 * for the exit, rendered with `closing`, which it applies with `closingProps` and must not act on.
 * Opening again while it fades mounts a fresh surface.
 */
export function Presence({ children, exitMs }: { children: Closable | null | false | undefined; exitMs?: number }) {
  const fallback = useExitMs();
  const element = isValidElement(children) ? (children as Closable) : null;
  const open = element !== null;
  const shown = useLingering(open, exitMs ?? fallback);
  const [kept, setKept] = useState<{ element: Closable | null; open: boolean; generation: number }>({ element, open, generation: 0 });
  // Taken while rendering, like `useLingering`, so the surface never unmounts for a frame.
  if (element && (kept.element !== element || !kept.open)) {
    setKept({ element, open: true, generation: kept.generation + (kept.open ? 0 : 1) });
  } else if (!element && kept.open) {
    setKept({ ...kept, open: false });
  }
  if (!shown || !kept.element) return null;
  return <Fragment key={kept.generation}>{cloneElement(kept.element, { closing: !open })}</Fragment>;
}
