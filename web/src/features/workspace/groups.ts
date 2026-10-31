import type { Thread } from "../../api/types";

const DAY_MS = 86_400_000;

export interface ThreadGroups {
  recent: Thread[];
  working: Thread[];
  settled: Thread[];
}

const newestFirst = (a: Thread, b: Thread) => b.updated_at.localeCompare(a.updated_at);

/**
 * Sidebar placement only, from what the server reports. Archived threads leave
 * the list and active runs are Working. Settled follows the server's lifecycle.
 * Payloads without one fall back to a quiet day, keeping failed runs in view.
 */
export function groupThreads(threads: readonly Thread[], now: number): ThreadGroups {
  const groups: ThreadGroups = { recent: [], working: [], settled: [] };
  for (const thread of threads) {
    const lifecycle = thread.lifecycle;
    if (lifecycle?.archived_at) continue;
    if (thread.active_run) {
      groups.working.push(thread);
      continue;
    }
    if (lifecycle) {
      (lifecycle.settled_at ? groups.settled : groups.recent).push(thread);
      continue;
    }
    const unresolved =
      thread.last_run_state === "failed" || thread.last_run_state === "interrupted";
    const age = now - new Date(thread.updated_at).getTime();
    (unresolved || age < DAY_MS ? groups.recent : groups.settled).push(thread);
  }
  groups.recent.sort(newestFirst);
  groups.working.sort(newestFirst);
  groups.settled.sort(newestFirst);
  return groups;
}
