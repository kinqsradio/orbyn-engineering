import type { JsonValue } from "../../api/types";
import type { ThreadItem } from "../../state/thread/projection";

/** Anthropic's documented default: a prompt cache stays warm five minutes after its last use. */
export const PROMPT_CACHE_MS = 5 * 60 * 1000;
/** The longer lifetime Anthropic offers, which Claude Code writes when it is enabled. */
export const LONG_PROMPT_CACHE_MS = 60 * 60 * 1000;

const field = (value: JsonValue | null | undefined, key: string): JsonValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;

/**
 * How long this thread's prompt cache lasts, from the engine's own usage report:
 * Claude's `cache_creation` says which lifetime the last turn wrote. A report
 * without that breakdown falls back to the documented five minutes.
 */
export function promptCacheMs(usage: JsonValue | null | undefined): number {
  const creation = field(field(usage, "raw"), "cache_creation");
  const long = field(creation, "ephemeral_1h_input_tokens");
  return typeof long === "number" && long > 0 ? LONG_PROMPT_CACHE_MS : PROMPT_CACHE_MS;
}

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
  usage = null,
  now = Date.now(),
}: {
  engine: string;
  activeRun: boolean;
  items: readonly Pick<ThreadItem, "ts">[];
  /** The thread's latest usage report, which may name the cache lifetime. */
  usage?: JsonValue | null;
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
  return arrivedAt - last > promptCacheMs(usage) && now >= arrivedAt;
}
