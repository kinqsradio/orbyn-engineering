import { useSyncExternalStore } from "react";

export type LayoutWidth = "narrow" | "medium" | "wide" | "xwide";

const NARROW = "(max-width: 767px)";
const WIDE = "(min-width: 1180px)";
const XWIDE = "(min-width: 1600px)";

const subscribe = (notify: () => void) => {
  const queries = [NARROW, WIDE, XWIDE].map((query) => window.matchMedia(query));
  for (const query of queries) query.addEventListener("change", notify);
  return () => {
    for (const query of queries) query.removeEventListener("change", notify);
  };
};

const snapshot = (): LayoutWidth => {
  if (window.matchMedia(NARROW).matches) return "narrow";
  if (window.matchMedia(XWIDE).matches) return "xwide";
  return window.matchMedia(WIDE).matches ? "wide" : "medium";
};

/**
 * Narrow shows one surface. Medium swaps panes with the thread. Wide fits the
 * details card or a pane; extra wide fits both, so the surface pane opens itself.
 */
export function useLayoutWidth(): LayoutWidth {
  return useSyncExternalStore(subscribe, snapshot);
}

export const isWide = (layout: LayoutWidth) => layout === "wide" || layout === "xwide";

const reducedMotion = "(prefers-reduced-motion: reduce)";

const subscribeMotion = (notify: () => void) => {
  const query = window.matchMedia(reducedMotion);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia(reducedMotion).matches);
}
