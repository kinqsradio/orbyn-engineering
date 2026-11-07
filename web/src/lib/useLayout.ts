import { useSyncExternalStore } from "react";

/**
 * The window's layout, by width (Engineer Designs, "Window widths and layouts"):
 * - phone, under 600: one column, the sidebar and the side panel are full-screen sheets;
 * - small, 600 to 899: the sidebar is a drawer, the side panel an overlay;
 * - medium, 900 to 1159: the sidebar stays docked, the side panel is an overlay;
 * - wide, 1160 and up: sidebar, thread and side panel all docked;
 * - xwide, 1600 and up: the details card fits beside the panel as well.
 */
export type LayoutWidth = "phone" | "small" | "medium" | "wide" | "xwide";

/** The first width of each layout above phone. */
export const SMALL_FROM = 600;
export const MEDIUM_FROM = 900;
export const WIDE_FROM = 1160;
export const XWIDE_FROM = 1600;

const PHONE = `(max-width: ${SMALL_FROM - 1}px)`;
const SMALL = `(max-width: ${MEDIUM_FROM - 1}px)`;
const WIDE = `(min-width: ${WIDE_FROM}px)`;
const XWIDE = `(min-width: ${XWIDE_FROM}px)`;

/** The layout a window of this width gets. */
export function layoutForWidth(width: number): LayoutWidth {
  if (width < SMALL_FROM) return "phone";
  if (width < MEDIUM_FROM) return "small";
  if (width < WIDE_FROM) return "medium";
  return width >= XWIDE_FROM ? "xwide" : "wide";
}

const subscribe = (notify: () => void) => {
  const queries = [PHONE, SMALL, WIDE, XWIDE].map((query) => window.matchMedia(query));
  for (const query of queries) query.addEventListener("change", notify);
  return () => {
    for (const query of queries) query.removeEventListener("change", notify);
  };
};

const snapshot = (): LayoutWidth => {
  if (window.matchMedia(PHONE).matches) return "phone";
  if (window.matchMedia(SMALL).matches) return "small";
  if (window.matchMedia(XWIDE).matches) return "xwide";
  return window.matchMedia(WIDE).matches ? "wide" : "medium";
};

/** Reads the layout live. The side panel docks only on wide and xwide; see `isWide`. */
export function useLayoutWidth(): LayoutWidth {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Sidebar, thread and side panel all docked. */
export const isWide = (layout: LayoutWidth) => layout === "wide" || layout === "xwide";

/** The side panel floats over the right of the thread, under its header, and does not move it. */
export const panelOverlays = (layout: LayoutWidth) => layout === "small" || layout === "medium";

const reducedMotion = "(prefers-reduced-motion: reduce)";

const subscribeMotion = (notify: () => void) => {
  const query = window.matchMedia(reducedMotion);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia(reducedMotion).matches);
}
