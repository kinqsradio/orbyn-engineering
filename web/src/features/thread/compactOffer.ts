import type { ThreadItem } from "./projection";

/** How long a provider keeps a prompt cache warm after a turn. */
export const PROMPT_CACHE_MS = 5 * 60 * 1000;

/**
 * The compact chip is offered when someone comes back to an idle Claude thread
 * after its prompt cache has gone cold: the next turn then pays for the whole
 * conversation again, and compacting first is cheaper.
 * Other engines keep no comparable cache, so they are not offered it.
 */
export function offerCompact({
  engine,
  activeRun,
  items,
  arrivedAt,
  now = Date.now(),
}: {
  engine: string;
  activeRun: boolean;
  items: readonly Pick<ThreadItem, "ts">[];
  /** When this visit to the thread started. */
  arrivedAt: number;
  now?: number;
}): boolean {
  if (engine !== "claude" || activeRun || items.length === 0) return false;
  const last = items.reduce((latest, item) => {
    const at = Date.parse(item.ts);
    return Number.isNaN(at) ? latest : Math.max(latest, at);
  }, 0);
  if (last === 0) return false;
  // The cache must have expired before this visit; a thread still warm on
  // arrival is not offered anything, even after sitting open for a while.
  return arrivedAt - last > PROMPT_CACHE_MS && now >= arrivedAt;
}
