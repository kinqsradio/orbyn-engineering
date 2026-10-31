import type { Project, Thread, UpdateThread } from "../../api/types";

const DAY_MS = 86_400_000;

export type SidebarSection = "pinned" | "active" | "working" | "snoozed" | "settled";
export type DropSection = "pinned" | "active" | "settled";
export type ThreadSort = "updated_at" | "created_at";
export type ProjectSort = "updated_at" | "created_at";

export type ThreadSections = Record<SidebarSection, Thread[]>;

export interface DropTarget {
  section: DropSection;
  index: number;
}

const position = (thread: Thread) => thread.lifecycle?.position ?? 0;

/** The server's saved order: activity never moves a thread. */
const savedOrder = (a: Thread, b: Thread) =>
  position(a) - position(b) || b.created_at.localeCompare(a.created_at);

const newest = (a: Thread, b: Thread) => b.updated_at.localeCompare(a.updated_at);

const isSnoozed = (thread: Thread, now: number) => {
  const until = thread.lifecycle?.snoozed_until;
  return Boolean(until) && new Date(until ?? 0).getTime() > now;
};

export interface WorkingShelf {
  enabled: boolean;
  waiting: ReadonlySet<string>;
}

const FOLD_WORKING: WorkingShelf = { enabled: true, waiting: new Set() };

/**
 * Where a thread sits, from what the server reports. The open thread stays put
 * while it runs, and a thread waiting on you stays in the list.
 */
export function sectionOf(
  thread: Thread,
  now: number,
  selectedId: string | null,
  /** Where the open thread was when you came to it. */
  held: SidebarSection | null = null,
  shelf: WorkingShelf = FOLD_WORKING,
): SidebarSection | null {
  const lifecycle = thread.lifecycle;
  if (!lifecycle) {
    if (thread.active_run) return "working";
    const unresolved = thread.last_run_state === "failed" || thread.last_run_state === "interrupted";
    const age = now - new Date(thread.updated_at).getTime();
    return unresolved || age < DAY_MS ? "active" : "settled";
  }
  if (lifecycle.archived_at || lifecycle.relation === "side") return null;
  // Settling on its own doesn't pull the thread you are in out of the list; leaving lets it go.
  if (lifecycle.settled_at) return thread.id === selectedId && held === "active" ? "active" : "settled";
  if (isSnoozed(thread, now)) return "snoozed";
  if (lifecycle.pinned_at) return "pinned";
  const needsYou = thread.active_run?.state === "awaiting_approval";
  const failed = !thread.active_run && thread.last_run_state === "failed";
  const waiting = !failed && (lifecycle.watching === true || shelf.waiting.has(thread.id));
  const working = (thread.active_run && !needsYou) || (!thread.active_run && waiting);
  return shelf.enabled && working && thread.id !== selectedId ? "working" : "active";
}

/** Parents of a delegated thread that is still running. */
export function waitingOnDelegates(threads: readonly Thread[]): ReadonlySet<string> {
  const waiting = new Set<string>();
  for (const thread of threads) {
    const parent = thread.lifecycle?.parent_thread_id;
    if (parent && thread.lifecycle?.relation === "subagent" && thread.active_run) waiting.add(parent);
  }
  return waiting;
}

export function arrangeThreads(
  threads: readonly Thread[],
  now: number,
  selectedId: string | null,
  held: SidebarSection | null = null,
  workingSection = true,
): ThreadSections {
  const sections: ThreadSections = { pinned: [], active: [], working: [], snoozed: [], settled: [] };
  const shelf = { enabled: workingSection, waiting: waitingOnDelegates(threads) };
  for (const thread of threads) {
    const section = sectionOf(thread, now, selectedId, held, shelf);
    if (section) sections[section].push(thread);
  }
  sections.pinned.sort(savedOrder);
  sections.active.sort(savedOrder);
  sections.working.sort(newest);
  sections.snoozed.sort((a, b) =>
    (a.lifecycle?.snoozed_until ?? "").localeCompare(b.lifecycle?.snoozed_until ?? ""),
  );
  sections.settled.sort(
    (a, b) => (b.lifecycle?.settled_at ?? b.updated_at).localeCompare(a.lifecycle?.settled_at ?? a.updated_at),
  );
  return sections;
}

export function threadsFlat(sections: ThreadSections): Thread[] {
  return [
    ...sections.pinned,
    ...sections.active,
    ...sections.working,
    ...sections.snoozed,
    ...sections.settled,
  ];
}

export type DropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

/** What dropping does, for the row's badge. Reordering in place has no verb. */
export function dropVerb(from: SidebarSection, to: SidebarSection | null): DropVerb | null {
  if (to === null || to === from || to === "working" || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

/** The lifecycle change that moves a thread between sections. */
export function dropPatch(from: SidebarSection, to: DropSection): UpdateThread | null {
  if (from === to) return null;
  if (to === "settled") return { settled: true };
  const leaving: UpdateThread =
    from === "settled" ? { settled: false } : from === "snoozed" ? { wake: true } : {};
  if (to === "pinned") return { ...leaving, pinned: true };
  return from === "pinned" ? { pinned: false } : leaving;
}

/** The sections as they will read once `id` lands on `target`. */
export function projectDrop(sections: ThreadSections, id: string, target: DropTarget): ThreadSections {
  const moved = threadsFlat(sections).find((thread) => thread.id === id);
  if (!moved) return sections;
  const next: ThreadSections = {
    pinned: sections.pinned.filter((thread) => thread.id !== id),
    active: sections.active.filter((thread) => thread.id !== id),
    working: sections.working.filter((thread) => thread.id !== id),
    snoozed: sections.snoozed.filter((thread) => thread.id !== id),
    settled: sections.settled.filter((thread) => thread.id !== id),
  };
  next[target.section].splice(target.index, 0, moved);
  return next;
}

/** Threads a press-drag covers: same section, between the two rows. */
export function sweepIds(
  ordered: readonly Thread[],
  originId: string,
  targetId: string,
  canApply: (thread: Thread) => boolean,
): string[] {
  const origin = ordered.findIndex((thread) => thread.id === originId);
  const target = ordered.findIndex((thread) => thread.id === targetId);
  if (origin < 0 || target < 0) return [];
  return ordered
    .slice(Math.min(origin, target), Math.max(origin, target) + 1)
    .filter(canApply)
    .map((thread) => thread.id);
}

export interface ProjectFolder {
  project: Project;
  threads: Thread[];
}

/** Project folders for the active list, each with its own threads. */
export function foldersOf(
  projects: readonly Project[],
  threads: readonly Thread[],
  projectSort: ProjectSort,
  threadSort: ThreadSort,
): ProjectFolder[] {
  const latest = (list: readonly Thread[], project: Project) =>
    list.reduce((at, thread) => (thread.updated_at > at ? thread.updated_at : at), project.created_at);
  return projects
    .map((project) => ({
      project,
      threads: threads
        .filter((thread) => thread.project_id === project.id)
        .sort((a, b) => b[threadSort].localeCompare(a[threadSort])),
    }))
    .sort((a, b) =>
      projectSort === "created_at"
        ? b.project.created_at.localeCompare(a.project.created_at)
        : latest(b.threads, b.project).localeCompare(latest(a.threads, a.project)),
    );
}
