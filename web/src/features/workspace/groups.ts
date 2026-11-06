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

/** Where a thread sits, from its lifecycle and whether it needs your attention. */
export function sectionOf(
  thread: Thread,
  now: number,
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
  if (lifecycle.settled_at) return "settled";
  if (isSnoozed(thread, now)) return "snoozed";
  if (lifecycle.pinned_at) return "pinned";
  const needsYou = thread.active_run?.state === "awaiting_approval";
  const failed = !thread.active_run && thread.last_run_state === "failed";
  const waiting = !failed && (lifecycle.watching === true || shelf.waiting.has(thread.id));
  const working = (thread.active_run && !needsYou) || (!thread.active_run && waiting);
  return shelf.enabled && working ? "working" : "active";
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

/** How urgently a thread wants the person: 0 needs them now, 1 failed, 2 anything else. */
export function attentionRank(thread: Thread): number {
  if (thread.active_run?.state === "awaiting_approval" || thread.lifecycle?.limit) return 0;
  if (!thread.active_run && thread.last_run_state === "failed") return 1;
  return 2;
}

export type LedgerKey = "needs" | "failed" | "running" | "done";
const LEDGER_ORDER: LedgerKey[] = ["needs", "failed", "running", "done"];

/** The Ledger section a thread sits in. */
export function ledgerKey(thread: Thread): LedgerKey {
  const rank = attentionRank(thread);
  return rank === 0 ? "needs" : rank === 1 ? "failed" : thread.active_run ? "running" : "done";
}

const LEDGER_SECTIONS: { key: LedgerKey; label: string; tone: "warn" | "danger" | "ink" }[] = [
  { key: "needs", label: "Needs you", tone: "warn" },
  { key: "failed", label: "Failed", tone: "danger" },
  { key: "running", label: "Running", tone: "ink" },
  { key: "done", label: "Done today", tone: "ink" },
];

/** Ledger's sections, in the order they are drawn. */
export function ledgerGroupsOf(active: readonly Thread[]) {
  return LEDGER_SECTIONS.map((section) => ({
    ...section,
    rows: active.filter((thread) => ledgerKey(thread) === section.key),
  }));
}

export function arrangeThreads(
  threads: readonly Thread[],
  now: number,
  workingSection = true,
  /** The Ledger layout lists what needs the person first; the saved order breaks ties. */
  needsYouFirst = false,
): ThreadSections {
  const sections: ThreadSections = { pinned: [], active: [], working: [], snoozed: [], settled: [] };
  const shelf = { enabled: workingSection, waiting: waitingOnDelegates(threads) };
  for (const thread of threads) {
    const section = sectionOf(thread, now, shelf);
    if (section) sections[section].push(thread);
  }
  sections.pinned.sort(savedOrder);
  // Ledger draws its sections in this order, so a drop position in `active` is a position on screen.
  sections.active.sort(
    needsYouFirst
      ? (a, b) => LEDGER_ORDER.indexOf(ledgerKey(a)) - LEDGER_ORDER.indexOf(ledgerKey(b)) || savedOrder(a, b)
      : savedOrder,
  );
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

/** One folder from the service's grouping catalog. */
export interface ProjectScopeGrouping {
  key: string;
  label: string;
  projectIds: readonly string[];
}

export interface ProjectFolder {
  key: string;
  label: string;
  /** The checkout whose badge and menu the folder uses. */
  project: Project;
  projects: Project[];
  threads: Thread[];
}

const newestThread = (threads: readonly Thread[]) =>
  threads.reduce((at, thread) => (thread.updated_at > at ? thread.updated_at : at), "");

const newestProject = (projects: readonly Project[]) =>
  projects.reduce((at, project) => (project.created_at > at ? project.created_at : at), "");

/**
 * Project folders for the active list. A null or partial catalog keeps each
 * unmatched checkout as its own folder, so grouping never hides a thread.
 */
export function foldersOf(
  projects: readonly Project[],
  threads: readonly Thread[],
  grouping: readonly ProjectScopeGrouping[] | null,
  projectSort: ProjectSort,
  threadSort: ThreadSort,
): ProjectFolder[] {
  const visible = new Map(projects.map((project) => [project.id, project]));
  const collected = new Map<string, { label: string; projects: Project[] }>();
  const placed = new Set<string>();
  for (const group of grouping ?? []) {
    const members = group.projectIds
      .map((id) => visible.get(id))
      .filter((project): project is Project => project !== undefined);
    if (members.length === 0) continue;
    // A one-checkout group keeps the project ID key it has without a catalog,
    // so its saved open state survives Separate, overrides and catalog failure.
    const key = group.projectIds.length === 1 ? group.projectIds[0]! : group.key;
    collected.set(key, { label: group.label, projects: members });
    for (const member of members) placed.add(member.id);
  }
  for (const project of projects) {
    if (!placed.has(project.id)) {
      collected.set(project.id, { label: project.name, projects: [project] });
    }
  }
  const folders = [...collected.entries()].map(([key, group]): ProjectFolder => ({
    key,
    label: group.label,
    project: group.projects[0]!,
    projects: group.projects,
    threads: threads
      .filter((thread) => group.projects.some((project) => project.id === thread.project_id))
      .sort((a, b) => b[threadSort].localeCompare(a[threadSort])),
  }));
  const activity = (folder: ProjectFolder) =>
    projectSort === "created_at"
      ? newestProject(folder.projects)
      : newestThread(folder.threads) > newestProject(folder.projects)
        ? newestThread(folder.threads)
        : newestProject(folder.projects);
  return folders.sort(
    (a, b) => activity(b).localeCompare(activity(a)) || a.label.localeCompare(b.label),
  );
}

/**
 * The threads in the order the sidebar draws them: what keyboard jumps, Shift-click ranges
 * and sweeps must follow. `folders` is null outside the folder view; a collapsed folder or
 * closed group draws nothing.
 */
export function drawnOrder(input: {
  sections: ThreadSections;
  ledger: boolean;
  folders: readonly ProjectFolder[] | null;
  strays: readonly Thread[];
  folderOpen(folder: ProjectFolder): boolean;
  groupOpen(id: "working" | "snoozed" | "settled"): boolean;
  settled: readonly Thread[];
}): Thread[] {
  const { sections } = input;
  const active = input.ledger
    ? ledgerGroupsOf(sections.active).flatMap((group) => group.rows)
    : input.folders
      ? [
          ...input.folders.flatMap((folder) => (input.folderOpen(folder) ? folder.threads : [])),
          ...input.strays,
        ]
      : sections.active;
  const shelf = input.groupOpen("working") ? sections.working : [];
  // The folder view draws the Working shelf above everything; the other views draw it below.
  return [
    ...(input.folders ? shelf : []),
    ...sections.pinned,
    ...active,
    ...(input.folders ? [] : shelf),
    ...(input.groupOpen("snoozed") ? sections.snoozed : []),
    ...(input.groupOpen("settled") ? input.settled : []),
  ];
}
