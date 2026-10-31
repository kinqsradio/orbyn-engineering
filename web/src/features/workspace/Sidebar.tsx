import {
  ChartColumn,
  ChevronRight,
  Copy,
  FilePen,
  FolderPlus,
  GitPullRequest,
  PanelLeft,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../api/client";
import type { Project, ServerSettings, Thread } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { DRAFT_KEY, useDraftStore } from "../onboarding/draftStore";
import { useLoopsWhileVisible } from "../../lib/visibleAnimation";
import { threadToken } from "../thread/skillMention";
import { navigate, routeHref, type Route } from "../../state/route";
import { DEFAULT_SIDEBAR_WIDTH, useUi } from "../../state/ui";
import { useVisibleProjects, useWorkspace } from "../../state/workspace";
import { OrbynMark, ProjectBadge } from "../../ui/badges";
import { Collapsible } from "../../ui/Collapsible";
import { IconButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ErrorState, Loading } from "../../ui/states";
import {
  arrangeThreads,
  dropPatch,
  dropVerb,
  foldersOf,
  projectDrop,
  sectionOf,
  sweepIds,
  threadsFlat,
  type DropSection,
  type DropTarget,
  type DropVerb,
  type SidebarSection,
  type ThreadSections,
} from "./groups";
import { trackPress } from "./pressGesture";
import { ProjectFilter } from "./ProjectFilter";
import {
  copyText,
  deleteThreads,
  dismissWoke,
  reorderThreads,
  settleThreads,
  unpinThreads,
  unsettleThreads,
  wakeThreads,
} from "./threadActions";
import { bulkMenuItems, CustomSnoozeDialog, snoozeChildren, threadMenuItems } from "./threadMenu";
import { ThreadRow, type RowActions } from "./ThreadRow";
import { pushUndo, undoLabel, undoLatest, useUndoNotice } from "./threadUndo";
import { UpdatePill } from "./Updates";

const SETTLED_PAGE = 10;

/** A project with no threads yet still needs a way in, and its trust state shown. */
function EmptyProjectRow({ project }: { project: Project }) {
  const target: Route = project.trusted
    ? { name: "new", projectId: project.id }
    : { name: "trust", projectId: project.id, threadId: null };
  return (
    <li>
      <a
        className="thread-row"
        href={routeHref(target)}
        aria-label={project.trusted ? `New thread in ${project.name}` : `Review trust for ${project.name}`}
      >
        <span className="thread-row-line">
          <ProjectBadge name={project.name} />
          <span className="thread-row-project">{project.name}</span>
          {project.trusted ? null : (
            <span className="row-status tone-warn" title="Folder not trusted">
              <ShieldAlert size={14} aria-hidden />
              Not trusted
            </span>
          )}
        </span>
        <span className="thread-row-empty">No threads yet</span>
      </a>
    </li>
  );
}

/** The unsent draft, reachable from anywhere; discarding it keeps it for the undo. */
function DraftRow({ route }: { route: Route }) {
  const text = useUi((state) => state.drafts[DRAFT_KEY] ?? "");
  const projectId = useUi((state) => state.draftProject);
  const files = useDraftStore((state) => state.files);
  if (route.name === "new" || route.name === "home" || (!text.trim() && files.length === 0)) return null;
  const discard = () => {
    const { setDraft } = useUi.getState();
    const { setFiles } = useDraftStore.getState();
    setDraft(DRAFT_KEY, "");
    setFiles([]);
    pushUndo("Discarded", async () => {
      setDraft(DRAFT_KEY, text);
      setFiles(files);
    });
  };
  return (
    <li className="draft-row">
      <a className="thread-row thread-row-compact" href={routeHref({ name: "new", projectId })}>
        <FilePen size={14} aria-hidden />
        <span className="thread-row-title">{text.trim().split("\n")[0] || `${files.length} files`}</span>
        <span className="row-trailing">
          <span className="row-rest">
            <span className="row-age">Unsent</span>
          </span>
          <span className="row-actions">
            <button
              type="button"
              className="row-action"
              aria-label="Discard draft"
              title="Discard draft"
              onClick={(event) => {
                event.preventDefault();
                discard();
              }}
            >
              <X size={14} aria-hidden />
            </button>
          </span>
        </span>
      </a>
    </li>
  );
}

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const clampWidth = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));

/** Resizes live through a CSS variable; the preference saves when the drag ends. */
function SidebarRail() {
  const width = useUi((state) => state.sidebarWidth);
  const setWidth = useUi((state) => state.setSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(width);
  const preview = (next: number) =>
    document.querySelector<HTMLElement>(".shell")?.style.setProperty("--sidebar-w", `${next}px`);

  return (
    <div
      className="sidebar-rail"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      data-dragging={dragging || undefined}
      title="Drag to resize"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        latest.current = width;
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        latest.current = clampWidth(event.clientX);
        preview(latest.current);
      }}
      onLostPointerCapture={() => {
        setDragging(false);
        setWidth(latest.current);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setWidth(clampWidth(width + (event.key === "ArrowRight" ? 16 : -16)));
      }}
      onDoubleClick={() => setWidth(DEFAULT_SIDEBAR_WIDTH)}
    />
  );
}

function Group({
  id,
  label,
  count,
  defaultOpen,
  dropSection,
  forceOpen,
  children,
}: {
  id: string;
  label: string;
  count: number;
  defaultOpen: boolean;
  dropSection?: DropSection;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const open = useUi((state) => state.groups[id] ?? defaultOpen);
  const toggle = useUi((state) => state.toggleGroup);
  return (
    <div className="group" data-drop-section={dropSection ?? "none"}>
      <Collapsible
        open={open || forceOpen === true}
        onOpenChange={() => toggle(id, defaultOpen)}
        summaryClassName="group-head"
        summary={
          <>
            <span>{label}</span>
            <span className="group-count">{count}</span>
            <ChevronRight size={14} className="chev" aria-hidden />
          </>
        }
      >
        <ul className="thread-list group-list">{children}</ul>
      </Collapsible>
    </div>
  );
}

function DragBoundary({ label, section, active }: { label: string; section: DropSection; active: boolean }) {
  return (
    <li className="drag-boundary" data-drop-section={section} data-active={active || undefined}>
      <span>{label}</span>
    </li>
  );
}

function DropPlaceholder({ label, section, active }: { label: string; section: DropSection; active: boolean }) {
  return (
    <li className="drop-placeholder" data-drop-section={section} data-active={active || undefined}>
      {label}
    </li>
  );
}

function UndoNotice() {
  const notice = useUndoNotice((state) => state.notice);
  if (!notice) return null;
  const summary = notice.count === 1 ? notice.action : `${notice.action} ${notice.count}`;
  return (
    <div className="undo-notice" role="status">
      <span>{summary},</span>
      <button type="button" onClick={() => void undoLatest()}>
        {undoLabel()}
      </button>
    </div>
  );
}

function SidebarFoot({ route }: { route: Route }) {
  return (
    <div className="sidebar-foot">
      <a
        className="icon-btn"
        href={routeHref({ name: "settings", section: null })}
        aria-label="Settings"
        title="Settings"
        aria-current={route.name === "settings" ? "page" : undefined}
      >
        <Settings size={16} aria-hidden />
      </a>
      <a
        className="icon-btn"
        href={routeHref({ name: "pulls" })}
        aria-label="Pull requests"
        title="Pull requests"
        aria-current={route.name === "pulls" ? "page" : undefined}
      >
        <GitPullRequest size={16} aria-hidden />
      </a>
      <a
        className="icon-btn"
        href={routeHref({ name: "usage" })}
        aria-label="Usage"
        title="Usage"
        aria-current={route.name === "usage" ? "page" : undefined}
      >
        <ChartColumn size={16} aria-hidden />
      </a>
      <UndoNotice />
      <UpdatePill />
    </div>
  );
}

function FolderHeader({
  project,
  collapsed,
  count,
  onToggle,
  onMenu,
}: {
  project: Project;
  collapsed: boolean;
  count: number;
  onToggle(): void;
  onMenu(event: React.MouseEvent): void;
}) {
  return (
    <li className="folder-head">
      <button
        type="button"
        className="folder-toggle"
        aria-expanded={!collapsed}
        onClick={onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(event);
        }}
      >
        <ProjectBadge name={project.name} />
        <span className="folder-name">{project.name}</span>
        {collapsed && count > 0 ? <span className="group-count">{count}</span> : null}
        <ChevronRight size={12} className="chev" aria-hidden />
      </button>
      <a
        className="icon-btn folder-new"
        href={routeHref({ name: "new", projectId: project.id })}
        aria-label={`New thread in ${project.name}`}
        title={`New thread in ${project.name}`}
      >
        <SquarePen size={14} aria-hidden />
      </a>
    </li>
  );
}

interface DragState {
  id: string;
  from: SidebarSection;
  target: DropTarget | null;
}

interface MenuState {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
}

const sweepVerbs: Partial<Record<SidebarSection, DropVerb>> = {
  settled: "unsettle",
  snoozed: "wake",
};

/** The slot under the pointer, skipping the dragged row. Null means nowhere to drop. */
function dropTargetAt(
  list: HTMLElement,
  y: number,
  dragged: string,
  sections: ThreadSections,
): DropTarget | null {
  let last: HTMLElement | null = null;
  for (const element of list.querySelectorAll<HTMLElement>("[data-drop-section], [data-thread-item]")) {
    if (element.dataset.threadItem === dragged) continue;
    if (element.getBoundingClientRect().top > y) break;
    last = element;
  }
  if (!last) return { section: "pinned", index: 0 };
  const marker = last.dataset.dropSection;
  if (marker) {
    return marker === "none" ? null : { section: marker as DropSection, index: 0 };
  }
  const section = last.dataset.section as SidebarSection;
  if (section === "working" || section === "snoozed") return null;
  const rows = sections[section].filter((thread) => thread.id !== dragged);
  const at = rows.findIndex((thread) => thread.id === last?.dataset.threadItem);
  const rect = last.getBoundingClientRect();
  return { section, index: at + (y > rect.top + rect.height / 2 ? 1 : 0) };
}

const threadIdAt = (list: HTMLElement, y: number) => {
  let id: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("[data-thread-item]")) {
    if (id !== null && row.getBoundingClientRect().top > y) break;
    id = row.dataset.threadItem ?? null;
  }
  return id;
};

const searchFields = (thread: Thread, project: string) =>
  `${thread.title} ${project} ${thread.worktree?.branch ?? ""}`.toLowerCase();

/** True while Mod is held on its own, when number badges show on the first rows. */
function useJumpHeld() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const sync = (event: KeyboardEvent) =>
      setHeld((/mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return held;
}

export const Sidebar = memo(function Sidebar({ route }: { route: Route }) {
  const jumpHeld = useJumpHeld();
  const projects = useWorkspace((state) => state.projects);
  const visibleProjects = useVisibleProjects();
  const setPalette = useUi((state) => state.setPalette);
  const threads = useWorkspace((state) => state.threads);
  const putThread = useWorkspace((state) => state.putThread);
  const refreshAll = useWorkspace((state) => state.refreshAll);
  const threadsLoaded = useWorkspace((state) => Object.values(state.threadIds).some((ids) => ids.data));
  const threadError = useWorkspace(
    (state) => Object.values(state.threadIds).find((ids) => ids.error && !ids.data)?.error,
  );
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const toggleGroup = useUi((state) => state.toggleGroup);
  const closedGroups = useUi((state) => state.groups);
  const projectFilter = useUi((state) => state.projectFilter);
  const projectFolders = useUi((state) => state.projectFolders);
  const multilineRows = useUi((state) => state.multilineRows);
  const threadSort = useUi((state) => state.threadSort);
  const projectSort = useUi((state) => state.projectSort);
  const setPrefs = useUi((state) => state.setPrefs);
  const pushToast = useUi((state) => state.pushToast);

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [settledVisible, setSettledVisible] = useState(SETTLED_PAGE);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [snoozing, setSnoozing] = useState<Thread[] | null>(null);
  const [deleting, setDeletingState] = useState<Thread[] | null>(null);
  const setDeleting = (threads: Thread[]) => {
    if (useUi.getState().confirmDelete) setDeletingState(threads);
    else void deleteThreads(threads);
  };
  const [drag, setDrag] = useState<DragState | null>(null);
  const [sweep, setSweep] = useState<{ verb: DropVerb; ids: ReadonlySet<string> } | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);

  const nav = useRef<HTMLElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const pointerY = useRef(0);
  const grabOffset = useRef(0);
  useLoopsWhileVisible(nav);
  const selectedThread = route.name === "thread" ? route.id : null;
  const list = useMemo(() => visibleProjects ?? [], [visibleProjects]);

  useEffect(() => {
    const abort = new AbortController();
    api.settings(abort.signal).then(setSettings, () => undefined);
    return () => abort.abort();
  }, []);
  const presets = useMemo(() => settings?.snooze_presets ?? [], [settings]);

  const scoped = useMemo(() => {
    const all = Object.values(threads);
    return projectFilter.length === 0 ? all : all.filter((thread) => projectFilter.includes(thread.project_id));
  }, [threads, projectFilter]);

  const hold = useRef<{ id: string; section: SidebarSection | null } | null>(null);
  if (hold.current?.id !== selectedThread || (hold.current && hold.current.section === null)) {
    const open = selectedThread ? threads[selectedThread] : undefined;
    hold.current =
      selectedThread === null
        ? null
        : { id: selectedThread, section: open ? sectionOf(open, Date.now(), selectedThread) : null };
  }
  const sections = arrangeThreads(scoped, Date.now(), selectedThread, hold.current?.section ?? null);
  const shown = drag?.target ? projectDrop(sections, drag.id, drag.target) : sections;
  const orderedRef = useRef<Thread[]>([]);
  orderedRef.current = threadsFlat(sections);
  const jumpRank = new Map(
    orderedRef.current
      .filter((thread) => !thread.lifecycle?.settled_at)
      .slice(0, 9)
      .map((thread, at) => [thread.id, at + 1]),
  );
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return scoped
      .filter((thread) => !thread.lifecycle?.archived_at && thread.lifecycle?.relation !== "side")
      .filter((thread) =>
        searchFields(thread, list.find((p) => p.id === thread.project_id)?.name ?? "").includes(needle),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [scoped, list, query]);
  const isSearching = query.trim() !== "";

  const emptyProjects = list.filter(
    (project) =>
      (projectFilter.length === 0 || projectFilter.includes(project.id)) &&
      !Object.values(threads).some((thread) => thread.project_id === project.id),
  );

  // Clicks on anything but a row drop the selection.
  useEffect(() => {
    if (selection.size === 0) return;
    const clear = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-thread-item], [data-menu-root]")) {
        setSelection(new Set());
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelection(new Set());
    };
    document.addEventListener("pointerdown", clear);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", clear);
      document.removeEventListener("keydown", key);
    };
  }, [selection]);

  const follow = useCallback(() => {
    if (!drag) return;
    const row = tree.current?.querySelector<HTMLElement>(`[data-thread-item="${CSS.escape(drag.id)}"]`);
    if (!row) return;
    row.style.transform = "";
    const top = row.getBoundingClientRect().top;
    row.style.transform = `translateY(${pointerY.current - grabOffset.current - top}px)`;
  }, [drag]);
  useLayoutEffect(follow);

  const finishDrop = async (thread: Thread, from: SidebarSection, target: DropTarget) => {
    if (target.section === "settled") {
      if (from !== "settled") await settleThreads([thread]);
      return;
    }
    const ordered = projectDrop(sectionsRef.current, thread.id, target)[target.section];
    const patch = dropPatch(from, target.section);
    if (!patch) {
      const before = sectionsRef.current[target.section].map((row) => row.id).join();
      if (before !== ordered.map((row) => row.id).join()) await reorderThreads(ordered);
      return;
    }
    try {
      if (from === "pinned" && target.section === "active") await unpinThreads([thread]);
      else putThread(await api.patchThread(thread.id, patch));
      await reorderThreads(ordered);
    } catch (failure) {
      pushToast(`Couldn't move the thread. ${toFailure(failure).message}`);
    }
  };

  /** A thread dropped on a composer becomes a link the agent can read. */
  const mentionInComposer = (rows: Thread[]) => {
    const key = selectedThread ?? DRAFT_KEY;
    const { drafts, setDraft } = useUi.getState();
    const links = rows.map((row) => threadToken(row.id, row.title)).join(" ");
    const before = drafts[key] ?? "";
    setDraft(key, before ? `${before.trimEnd()} ${links} ` : `${links} `);
  };

  const actions: RowActions = {
    onClick(event, thread) {
      const mod = /mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (mod) {
        event.preventDefault();
        setAnchorId(thread.id);
        setSelection((current) => {
          const next = new Set(current);
          if (!next.delete(thread.id)) next.add(thread.id);
          return next;
        });
      } else if (event.shiftKey) {
        event.preventDefault();
        const rows = orderedRef.current;
        const from = rows.findIndex((row) => row.id === (anchorId ?? selectedThread));
        const to = rows.findIndex((row) => row.id === thread.id);
        const start = from < 0 ? to : Math.min(from, to);
        const end = from < 0 ? to : Math.max(from, to);
        setSelection(new Set(rows.slice(start, end + 1).map((row) => row.id)));
      } else if (event.detail === 2) {
        event.preventDefault();
        setRenaming(thread.id);
      } else if (selection.size > 0) {
        setSelection(new Set());
      }
    },
    onPressStart(event, thread, section) {
      if (event.button !== 0 || section === "working" || projectFolders) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || renaming === thread.id) return;
      const row = event.currentTarget.closest("li");
      if (!row || !tree.current) return;
      const list = tree.current;
      grabOffset.current = event.clientY - row.getBoundingClientRect().top;
      pointerY.current = event.clientY;
      let target: DropTarget | null = null;
      const reset = () => {
        row.style.transform = "";
        setDrag(null);
      };
      trackPress(event, {
        onStart: () => setDrag({ id: thread.id, from: section, target: null }),
        onMove: (y) => {
          pointerY.current = y;
          target = dropTargetAt(list, y, thread.id, shownRef.current);
          setDrag((current) =>
            current && sameTarget(current.target, target) ? current : current && { ...current, target },
          );
          follow();
        },
        onEnd: (at) => {
          reset();
          const composer = document.elementFromPoint(at.x, at.y)?.closest(".composer");
          if (composer) mentionInComposer(selection.has(thread.id) ? orderedRef.current.filter((row) => selection.has(row.id)) : [thread]);
          else if (target) void finishDrop(thread, section, target);
        },
        onCancel: reset,
      });
    },
    onActionPress(event, thread, section) {
      if (event.button !== 0 || !tree.current) return;
      event.stopPropagation();
      const list = tree.current;
      const verb = sweepVerbs[section] ?? "settle";
      const same = (row: Thread) =>
        sectionsRef.current[section].some((entry) => entry.id === row.id);
      let ids: string[] = [];
      const sweepTo = (id: string | null) => {
        if (!id) return;
        ids = sweepIds(orderedRef.current, thread.id, id, same);
        setSweep({ verb, ids: new Set(ids) });
      };
      trackPress(event, {
        onStart: () => sweepTo(thread.id),
        onMove: (y) => sweepTo(threadIdAt(list, y)),
        onEnd: () => {
          setSweep(null);
          const swept = orderedRef.current.filter((row) => ids.includes(row.id));
          if (verb === "settle") void settleThreads(swept);
          else if (verb === "unsettle") void unsettleThreads(swept);
          else void wakeThreads(swept);
        },
        onCancel: () => setSweep(null),
      });
    },
    onMenu(event, thread) {
      if (selection.has(thread.id) && selection.size > 1) {
        const picked = orderedRef.current.filter((row) => selection.has(row.id));
        setMenu({
          x: event.clientX,
          y: event.clientY,
          label: `Actions for ${picked.length} threads`,
          items: bulkMenuItems(picked, presets, setSnoozing, setDeleting),
        });
        return;
      }
      setSelection(new Set());
      const project = list.find((p) => p.id === thread.project_id);
      const branch =
        thread.worktree?.branch ??
        useWorkspace.getState().managed.data?.targets.find((t) => t.project_id === thread.project_id)?.branch ??
        null;
      const filterActive = projectFilter.length > 0;
      setMenu({
        x: event.clientX,
        y: event.clientY,
        label: `Actions for ${thread.title}`,
        items: threadMenuItems({
          thread,
          branch,
          projectName: project?.name ?? "this project",
          filterActive,
          presets,
          onRename: () => setRenaming(thread.id),
          onCustomSnooze: setSnoozing,
          onDelete: setDeleting,
          onFilter: () => setPrefs({ projectFilter: filterActive ? [] : [thread.project_id] }),
        }),
      });
    },
    onRenameDone: () => setRenaming(null),
    onSettle: (thread) => void settleThreads([thread]),
    onUnsettle: (thread) => void unsettleThreads([thread]),
    onWake: (thread) => void wakeThreads([thread]),
    onUnpin: (thread) => void unpinThreads([thread]),
    onSnooze(event, thread) {
      setMenu({
        x: event.clientX,
        y: event.clientY,
        label: "Snooze thread",
        items: snoozeChildren([thread], presets, () => setSnoozing([thread])),
      });
    },
    onRowFocus: setFocusId,
    onDismissWoke: (thread) => void dismissWoke(thread),
    onFiles(thread, files) {
      useDraftStore.getState().drop(thread.id, files);
      navigate({ name: "thread", id: thread.id });
    },
  };

  const onTreeKey = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT") return;
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>("a.thread-row, button.group-head") ?? [])];
    const at = rows.indexOf(target);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (at < 0) return;
      event.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      return;
    }
    const id = target.closest<HTMLElement>("[data-thread-item]")?.dataset.threadItem;
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && target.matches("button.group-head")) {
      const open = target.getAttribute("aria-expanded") === "true";
      if (open === (event.key === "ArrowLeft")) target.click();
      event.preventDefault();
      return;
    }
    const thread = id ? threads[id] : undefined;
    if (!thread) return;
    if (event.key === "F2") {
      event.preventDefault();
      setRenaming(thread.id);
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      actions.onMenu({ clientX: rect.left + 12, clientY: rect.bottom }, thread);
    }
  };

  const firstRow = orderedRef.current[0]?.id ?? null;
  const rovingId =
    focusId && threads[focusId] ? focusId : selectedThread && threads[selectedThread] ? selectedThread : firstRow;

  const row = (thread: Thread, section: SidebarSection, compact: boolean, highlighted = false) => {
    const dragged = drag?.id === thread.id;
    const verb = dragged
      ? dropVerb(drag.from, drag.target?.section ?? null)
      : sweep?.ids.has(thread.id)
        ? sweep.verb
        : null;
    return (
      <ThreadRow
        key={thread.id}
        jumpHint={jumpHeld ? jumpRank.get(thread.id) ?? null : null}
        thread={thread}
        section={section}
        selected={thread.id === selectedThread}
        compact={compact}
        multiline={multilineRows}
        multiSelected={selection.has(thread.id)}
        renaming={renaming === thread.id}
        focusable={thread.id === rovingId}
        dragging={dragged}
        highlighted={highlighted}
        verb={verb}
        actions={actions}
      />
    );
  };

  const dragTarget = drag?.target?.section ?? null;
  const dragging = drag !== null;
  const noActiveRows = shown.active.length === 0 && emptyProjects.length === 0;
  const settledRows = shown.settled.slice(0, Math.max(settledVisible, 1));
  const folders = projectFolders
    ? foldersOf(
        projectFilter.length > 0 ? list.filter((p) => projectFilter.includes(p.id)) : list,
        [...shown.active, ...shown.working],
        projectSort,
        threadSort,
      )
    : [];
  const shelves = projectFolders ? [] : shown.working;
  const hasShelf =
    shelves.length > 0 || shown.snoozed.length > 0 || shown.settled.length > 0 || dragging;

  const folderMenu = (event: React.MouseEvent, project: Project) => {
    setMenu({
      x: event.clientX,
      y: event.clientY,
      label: `Actions for ${project.name}`,
      items: [
        {
          label: "New thread",
          icon: <SquarePen size={14} aria-hidden />,
          onSelect: () => navigate({ name: "new", projectId: project.id }),
        },
        {
          label: "Copy path",
          icon: <Copy size={14} aria-hidden />,
          onSelect: () => void copyText(project.path, "Copied path"),
        },
        {
          label: "Project settings",
          icon: <Settings size={14} aria-hidden />,
          onSelect: () => navigate({ name: "settings", section: "projects" }),
        },
      ],
    });
  };

  return (
    <nav ref={nav} className="sidebar" aria-label="Workspace">
      <div className="sidebar-top">
        <IconButton label="Collapse sidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} aria-hidden />
        </IconButton>
        <a className="brand" href={routeHref({ name: "home" })}>
          <OrbynMark />
          Orbyn Engineering
        </a>
      </div>
      <div className="sidebar-search">
        {searching ? (
          <div className="search-field">
            <Search size={16} aria-hidden />
            <input
              type="search"
              aria-label="Search threads"
              placeholder="Search"
              value={query}
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSearching(false);
                } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setHighlight((at) => Math.min(results.length - 1, Math.max(0, at + step)));
                } else if (event.key === "Enter") {
                  const hit = results[highlight];
                  if (hit) navigate({ name: "thread", id: hit.id });
                }
              }}
            />
            <IconButton
              label="Close search"
              onClick={() => {
                setQuery("");
                setSearching(false);
              }}
            >
              <X size={14} aria-hidden />
            </IconButton>
          </div>
        ) : (
          <button type="button" className="search-trigger" onClick={() => setSearching(true)}>
            <Search size={16} aria-hidden />
            <span>Search</span>
          </button>
        )}
        <ProjectFilter projects={list} />
        <IconButton label="Add project" onClick={() => setPalette("add-project")}>
          <FolderPlus size={16} aria-hidden />
        </IconButton>
        <a
          className="icon-btn"
          href={routeHref({ name: "new", projectId: null })}
          aria-label="New thread"
          title="New thread"
        >
          <SquarePen size={16} aria-hidden />
        </a>
      </div>
      <div className="sidebar-scroll" ref={tree} onKeyDown={onTreeKey} data-dragging={dragging || undefined}>
        {projects.error && !projects.data ? (
          <ErrorState compact title="Couldn't load projects" failure={projects.error} onRetry={() => void refreshAll()} />
        ) : threadError && !threadsLoaded ? (
          <ErrorState compact title="Couldn't load threads" failure={threadError} onRetry={() => void refreshAll()} />
        ) : !projects.data || (list.length > 0 && !threadsLoaded) ? (
          <Loading label="Loading threads" rows={5} />
        ) : isSearching ? (
          results.length === 0 ? (
            <p className="sidebar-empty">No matching threads</p>
          ) : (
            <ul className="thread-list" role="list" aria-label="Thread search results">
              {results.map((thread, at) =>
                row(thread, sectionOf(thread, Date.now(), selectedThread) ?? "active", false, at === highlight),
              )}
            </ul>
          )
        ) : (
          <>
            <ul className="thread-list">
              <DraftRow route={route} />
              {dragging ? <DragBoundary label="Pinned" section="pinned" active={dragTarget === "pinned"} /> : null}
              {shown.pinned.map((thread) => row(thread, "pinned", false))}
              {dragging ? <DragBoundary label="Active" section="active" active={dragTarget === "active"} /> : null}
              {projectFolders
                ? folders.map(({ project, threads: rows }) => {
                    const key = `folder:${project.id}`;
                    const collapsed = closedGroups[key] === false;
                    return [
                      <FolderHeader
                        key={key}
                        project={project}
                        collapsed={collapsed}
                        count={rows.length}
                        onToggle={() => toggleGroup(key, true)}
                        onMenu={(event) => folderMenu(event, project)}
                      />,
                      ...(collapsed ? [] : rows.map((thread) => row(thread, "active", true))),
                    ];
                  })
                : shown.active.map((thread) => row(thread, "active", false))}
              {projectFolders ? null : emptyProjects.map((project) => <EmptyProjectRow key={project.id} project={project} />)}
              {dragging && noActiveRows ? (
                <DropPlaceholder label="Active" section="active" active={dragTarget === "active"} />
              ) : null}
            </ul>
            {hasShelf ? (
              <div className="sidebar-groups">
                {shelves.length > 0 ? (
                  <Group id="working" label="Working" count={shelves.length} defaultOpen>
                    {shelves.map((thread) => row(thread, "working", false))}
                  </Group>
                ) : null}
                {shown.snoozed.length > 0 ? (
                  <Group id="snoozed" label="Snoozed" count={shown.snoozed.length} defaultOpen>
                    {shown.snoozed.map((thread) => row(thread, "snoozed", true))}
                  </Group>
                ) : null}
                {shown.settled.length > 0 || dragging ? (
                  <Group
                    id="settled"
                    label="Settled"
                    count={shown.settled.length}
                    defaultOpen={false}
                    dropSection="settled"
                    forceOpen={dragging}
                  >
                    {settledRows.map((thread) => row(thread, "settled", true))}
                    {shown.settled.length === 0 ? (
                      <DropPlaceholder label="Settled" section="settled" active={dragTarget === "settled"} />
                    ) : null}
                    {shown.settled.length > settledRows.length ? (
                      <li>
                        <button
                          type="button"
                          className="show-more"
                          onClick={() => setSettledVisible(settledVisible + SETTLED_PAGE)}
                        >
                          Show {Math.min(SETTLED_PAGE, shown.settled.length - settledRows.length)} more
                        </button>
                      </li>
                    ) : null}
                  </Group>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      <SidebarFoot route={route} />
      <SidebarRail />
      {menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null}
      {snoozing ? <CustomSnoozeDialog threads={snoozing} onClose={() => setSnoozing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title={deleting.length === 1 ? "Delete thread?" : `Delete ${deleting.length} threads?`}
          confirmLabel="Delete"
          tone="danger"
          onClose={() => setDeletingState(null)}
          onConfirm={() => deleteThreads(deleting)}
        >
          <p>This also removes side chats and cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </nav>
  );
});

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a?.section === b?.section && a?.index === b?.index;
