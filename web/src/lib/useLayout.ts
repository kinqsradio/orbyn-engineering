import { useSyncExternalStore } from "react";

export type LayoutWidth = "narrow" | "medium" | "wide";

const NARROW = "(max-width: 767px)";
const WIDE = "(min-width: 1180px)";

const subscribe = (notify: () => void) => {
  const queries = [window.matchMedia(NARROW), window.matchMedia(WIDE)];
  for (const query of queries) query.addEventListener("change", notify);
  return () => {
    for (const query of queries) query.removeEventListener("change", notify);
  };
};

const snapshot = (): LayoutWidth => {
  if (window.matchMedia(NARROW).matches) return "narrow";
  return window.matchMedia(WIDE).matches ? "wide" : "medium";
};

/** Narrow shows one surface; medium swaps the context panel with the thread. */
export function useLayoutWidth(): LayoutWidth {
  return useSyncExternalStore(subscribe, snapshot);
}
