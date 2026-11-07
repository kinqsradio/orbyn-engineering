import { useSyncExternalStore } from "react";

/**
 * The browser does not say whether Back or Forward has anywhere to go, so each history entry carries
 * its position in the trail. An address arriving on an entry that already has a position is a
 * Back/Forward step and moves to it. One arriving on an entry with none (a followed link) is a new
 * place: it takes the next position and drops what was ahead, even if it is an address seen before.
 */
interface Trail {
  at: number;
  size: number;
}

const KEY = "orbynTrail";
let trail: Trail = { at: 0, size: 1 };
let snapshot = { back: false, forward: false };
const listeners = new Set<() => void>();

const positionOf = (state: unknown): number | null => {
  const value = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[KEY] : null;
  return typeof value === "number" ? value : null;
};

function stamp(at: number) {
  const state = window.history.state;
  window.history.replaceState({ ...(typeof state === "object" && state !== null ? state : {}), [KEY]: at }, "");
}

function publish() {
  const next = { back: trail.at > 0, forward: trail.at < trail.size - 1 };
  if (next.back === snapshot.back && next.forward === snapshot.forward) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function arrive() {
  const known = positionOf(window.history.state);
  if (known !== null) trail = { at: known, size: Math.max(trail.size, known + 1) };
  else {
    const at = trail.at + 1;
    stamp(at);
    trail = { at, size: at + 1 };
  }
  publish();
}

function seed() {
  const known = positionOf(window.history.state);
  if (known === null) stamp(0);
  // A reload keeps the position but not what lies ahead.
  trail = { at: known ?? 0, size: (known ?? 0) + 1 };
}

/** Forgets the trail and starts again at the current entry; exported for tests. */
export function resetTrail(): void {
  if (typeof window !== "undefined") {
    stamp(0);
    trail = { at: 0, size: 1 };
  }
  snapshot = { back: false, forward: false };
}

let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  seed();
  publish();
  window.addEventListener("hashchange", arrive);
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
