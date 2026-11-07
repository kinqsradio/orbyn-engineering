import { useSyncExternalStore } from "react";

/**
 * The browser does not say whether Back or Forward has anywhere to go, so the window keeps its own
 * trail of the places it has shown. Moving to the address just behind or ahead is a step along the
 * trail; any other address starts a new branch and drops what was ahead.
 */
interface Trail {
  places: string[];
  at: number;
}

let trail: Trail = { places: [], at: -1 };
let snapshot = { back: false, forward: false };
const listeners = new Set<() => void>();

function publish() {
  const next = { back: trail.at > 0, forward: trail.at < trail.places.length - 1 };
  if (next.back === snapshot.back && next.forward === snapshot.forward) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** Records the current address as the window moves; exported for tests. */
export function visit(place: string): void {
  if (trail.places[trail.at] === place) return;
  if (trail.places[trail.at - 1] === place) trail = { ...trail, at: trail.at - 1 };
  else if (trail.places[trail.at + 1] === place) trail = { ...trail, at: trail.at + 1 };
  else trail = { places: [...trail.places.slice(0, trail.at + 1), place], at: trail.at + 1 };
  publish();
}

export function resetTrail(): void {
  trail = { places: [], at: -1 };
  snapshot = { back: false, forward: false };
}

let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  visit(window.location.hash);
  window.addEventListener("hashchange", () => visit(window.location.hash));
}

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const goBack = () => window.history.back();
export const goForward = () => window.history.forward();

export function useNavHistory(): { back: boolean; forward: boolean } {
  return useSyncExternalStore(subscribe, () => snapshot);
}
