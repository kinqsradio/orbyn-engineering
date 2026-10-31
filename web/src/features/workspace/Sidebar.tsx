import {
  BarChart3,
  ChevronRight,
  FolderPlus,
  GitBranch,
  ListFilter,
  OctagonAlert,
  PanelLeft,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  X,
  CircleCheck,
  Unplug,
  Archive,
  Clock,
  Mail,
  Pin,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/client";
import type { Project, Thread, UpdateThread } from "../../api/types";
import { compactAge, elapsed, runStateLabels } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { useNow } from "../../lib/useNow";
import { useLoopsWhileVisible } from "../../lib/visibleAnimation";
import { routeHref, type Route } from "../../state/route";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { EngineGlyph, OrbynMark, ProjectBadge } from "../../ui/badges";
import { Collapsible } from "../../ui/Collapsible";
import { IconButton, Pill } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { ErrorState, Loading } from "../../ui/states";
import { ApprovalsLink } from "./ApprovalsLink";
import { groupThreads } from "./groups";
import { threadRunState } from "./RunState";
import { UpdatePill } from "./Updates";

const DONE_WINDOW_MS = 5 * 60_000;
const RECENT_LIMIT = 12;
const SETTLED_LIMIT = 10;

function RowStatus({ thread }: { thread: Thread }) {
  const active = thread.active_run;
  const now = useNow(active !== null);
  if (active) {
    const waiting = active.state === "awaiting_approval";
    const label = active.state === "admitted" ? "Queued" : waiting ? "Waiting" : "Working";
    return (
      <span className={`row-status ${waiting ? "tone-warn" : "tone-info"}`}>
        <span className="status-dot" aria-hidden />
        {label} {elapsed(active.started_at, now)}
      </span>
    );
  }
  const state = thread.last_run_state;
  if (state === "failed") {
    return (
      <span className="row-status tone-danger">
        <OctagonAlert size={14} aria-hidden />
        Failed
      </span>
    );
  }
  if (state === "interrupted") {
    return (
      <span className="row-status tone-warn">
        <Unplug size={14} aria-hidden />
        Interrupted
      </span>
    );
  }
  const fresh =
    thread.lifecycle?.unread ?? Date.now() - new Date(thread.updated_at).getTime() < DONE_WINDOW_MS;
  if (state === "completed" && fresh) {
    return (
      <span className="row-status tone-success">
        <CircleCheck size={14} aria-hidden />
        Done
      </span>
    );
  }
  return (
    <time className="row-age" dateTime={thread.updated_at}>
      {compactAge(thread.updated_at)}
    </time>
  );
}

const HOVER_DELAY_MS = 150;

/** Details for a row, beside it, after upstream's 150 ms delay. Pointer only. */
function ThreadHoverCard({
  thread,
  projectName,
  branch,
  engineName,
  anchor,
}: {
  thread: Thread;
  projectName: string;
  branch: string | null;
  engineName: string;
  anchor: DOMRect;
}) {
  const state = threadRunState(thread);
  return createPortal(
    <div className="hover-card" role="tooltip" style={{ left: anchor.right + 4, top: anchor.top }}>
      <p className="hover-card-title">{thread.title}</p>
      <div className="hover-card-rows">
        <div>
          <ProjectBadge name={projectName} />
          <span>{projectName}</span>
        </div>
        {branch ? (
          <div>
            <GitBranch size={12} aria-hidden />
            <span>{branch}</span>
          </div>
        ) : null}
        <div>
          <EngineGlyph name={engineName} />
          <span>{thread.model ? `${engineName}, ${thread.model}` : engineName}</span>
        </div>
        {state ? (
          <div>
            <Clock size={12} aria-hidden />
            <span>
              {runStateLabels[state]}, {compactAge(thread.updated_at)}
            </span>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function ThreadRow({
  thread,
  selected,
  compact,
}: {
  thread: Thread;
  selected: boolean;
  /** Settled threads are one quiet line. */
  compact?: boolean;
}) {
  const project = useWorkspace((state) =>
    state.projects.data?.find((p) => p.id === thread.project_id),
  );
  const engine = useWorkspace((state) => engineById(state.engines.data, thread.engine));
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.targets.find((t) => t.project_id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const unmanaged = engine?.capabilities.managed === false;
  const projectName = project?.name ?? "Unknown project";
  const engineName = engine?.name ?? thread.engine;
  const putThread = useWorkspace((state) => state.putThread);
  const pushToast = useUi((state) => state.pushToast);
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const lifecycle = thread.lifecycle;
  const patch = (body: UpdateThread, done: string) => {
    api.patchThread(thread.id, body).then(
      (next) => {
        putThread(next);
        pushToast(done);
      },
      (failure: unknown) => pushToast(`Couldn't update the thread. ${toFailure(failure).message}`),
    );
  };

  return (
    <li>
      <a
        className={compact ? "thread-row thread-row-compact" : "thread-row"}
        href={routeHref({ name: "thread", id: thread.id })}
        aria-current={selected ? "page" : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          const rect = event.currentTarget.getBoundingClientRect();
          timer.current = setTimeout(() => setHover(rect), HOVER_DELAY_MS);
        }}
        onPointerLeave={() => {
          clearTimeout(timer.current);
          setHover(null);
        }}
        onContextMenu={(event) => {
          if (!lifecycle) return;
          event.preventDefault();
          clearTimeout(timer.current);
          setHover(null);
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {compact ? (
          <>
            <ProjectBadge name={projectName} />
            <span className="thread-row-title">{thread.title}</span>
            <RowStatus thread={thread} />
          </>
        ) : (
          <>
        <span className="thread-row-line">
          <ProjectBadge name={projectName} />
          <span className="thread-row-project">{projectName}</span>
          <RowStatus thread={thread} />
        </span>
        <span className="thread-row-title">{thread.title}</span>
        <span className="thread-row-line thread-row-foot">
          <span className="thread-row-branch">
            {branch ? (
              <>
                <GitBranch size={12} aria-hidden />
                {branch}
              </>
            ) : null}
          </span>
          {unmanaged ? <Pill tone="warn">Unmanaged</Pill> : null}
          <EngineGlyph name={engineName} />
        </span>
          </>
        )}
      </a>
      {hover && !menu ? (
        <ThreadHoverCard
          thread={thread}
          projectName={projectName}
          branch={branch}
          engineName={engineName}
          anchor={hover}
        />
      ) : null}
      {menu && lifecycle ? (
        <Menu
          {...menu}
          label={`Actions for ${thread.title}`}
          onClose={() => setMenu(null)}
          items={[
            {
              label: lifecycle.pinned_at ? "Unpin" : "Pin",
              icon: <Pin size={14} aria-hidden />,
              onSelect: () => patch({ pinned: !lifecycle.pinned_at }, lifecycle.pinned_at ? "Unpinned" : "Pinned"),
            },
            {
              label: lifecycle.settled_at ? "Unsettle" : "Settle",
              icon: <CircleCheck size={14} aria-hidden />,
              onSelect: () =>
                patch({ settled: !lifecycle.settled_at }, lifecycle.settled_at ? "Back in the list" : "Settled"),
            },
            {
              label: lifecycle.unread ? "Mark as read" : "Mark as unread",
              icon: <Mail size={14} aria-hidden />,
              onSelect: () => patch({ unread: !lifecycle.unread }, "Updated"),
            },
            {
              label: "Archive",
              icon: <Archive size={14} aria-hidden />,
              disabled: thread.active_run !== null,
              onSelect: () => patch({ archived: true }, "Archived"),
            },
          ]}
        />
      ) : null}
    </li>
  );
}

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
              Untrusted
            </span>
          )}
        </span>
        <span className="thread-row-empty">No threads yet</span>
      </a>
    </li>
  );
}

function Group({
  id,
  label,
  count,
  defaultOpen,
  children,
}: {
  id: string;
  label: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const open = useUi((state) => state.groups[id] ?? defaultOpen);
  const toggle = useUi((state) => state.toggleGroup);
  return (
    <Collapsible
      className="group"
      open={open}
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
      <ApprovalsLink current={route.name === "approvals"} />
      <a
        className="icon-btn"
        href={routeHref({ name: "settings", section: "audit" })}
        aria-label="Audit log"
        title="Audit log"
      >
        <BarChart3 size={16} aria-hidden />
      </a>
      <UpdatePill />
    </div>
  );
}

export const Sidebar = memo(function Sidebar({ route }: { route: Route }) {
  const projects = useWorkspace((state) => state.projects);
  const threads = useWorkspace((state) => state.threads);
  const refreshAll = useWorkspace((state) => state.refreshAll);
  const threadsLoaded = useWorkspace((state) => Object.values(state.threadIds).some((ids) => ids.data));
  const threadError = useWorkspace(
    (state) => Object.values(state.threadIds).find((ids) => ids.error && !ids.data)?.error,
  );
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [needsAttention, setNeedsAttention] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showAllSettled, setShowAllSettled] = useState(false);
  const nav = useRef<HTMLElement>(null);
  useLoopsWhileVisible(nav);
  const selectedThread = route.name === "thread" ? route.id : null;
  const list = useMemo(() => projects.data ?? [], [projects.data]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(threads).filter((thread) => {
      if (
        needsAttention &&
        !thread.active_run &&
        thread.last_run_state !== "failed" &&
        thread.last_run_state !== "interrupted"
      ) {
        return false;
      }
      if (!needle) return true;
      const project = list.find((p) => p.id === thread.project_id)?.name ?? "";
      return `${thread.title} ${project}`.toLowerCase().includes(needle);
    });
  }, [threads, list, query, needsAttention]);

  const groups = groupThreads(visible, Date.now());
  const emptyProjects = list.filter(
    (project) => !Object.values(threads).some((thread) => thread.project_id === project.id),
  );
  const filtering = query.trim() !== "" || needsAttention;
  const selectedAt = groups.recent.findIndex((thread) => thread.id === selectedThread);
  const recentLimit = Math.max(RECENT_LIMIT, selectedAt + 1);
  const settledRows = showAllSettled ? groups.settled : groups.settled.slice(0, SETTLED_LIMIT);
  const row = (thread: Thread) => (
    <ThreadRow key={thread.id} thread={thread} selected={thread.id === selectedThread} />
  );

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
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSearching(false);
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
        <IconButton
          label="Show only active and failed"
          pressed={needsAttention}
          onClick={() => setNeedsAttention(!needsAttention)}
        >
          <ListFilter size={16} aria-hidden />
        </IconButton>
        <a className="icon-btn" href={routeHref({ name: "add-project" })} aria-label="Add project" title="Add project">
          <FolderPlus size={16} aria-hidden />
        </a>
        <a
          className="icon-btn"
          href={routeHref({ name: "new", projectId: null })}
          aria-label="New thread"
          title="New thread"
        >
          <SquarePen size={16} aria-hidden />
        </a>
      </div>
      <div className="sidebar-scroll">
        {projects.error && !projects.data ? (
          <ErrorState compact title="Couldn't load projects" failure={projects.error} onRetry={() => void refreshAll()} />
        ) : threadError && !threadsLoaded ? (
          <ErrorState compact title="Couldn't load threads" failure={threadError} onRetry={() => void refreshAll()} />
        ) : !projects.data || (list.length > 0 && !threadsLoaded) ? (
          <Loading label="Loading threads" rows={5} />
        ) : groups.recent.length === 0 && groups.working.length === 0 && groups.settled.length === 0 && filtering ? (
          <p className="sidebar-empty">No matching threads</p>
        ) : (
          <>
            <ul className="thread-list">
              {(showAll || filtering ? groups.recent : groups.recent.slice(0, recentLimit)).map(row)}
              {filtering ? null : emptyProjects.map((project) => <EmptyProjectRow key={project.id} project={project} />)}
            </ul>
            {!showAll && !filtering && groups.recent.length > recentLimit ? (
              <button type="button" className="show-more" onClick={() => setShowAll(true)}>
                Show {groups.recent.length - recentLimit} more
              </button>
            ) : null}
          </>
        )}
      </div>
      {groups.working.length > 0 || groups.settled.length > 0 ? (
        <div className="sidebar-groups">
          {groups.working.length > 0 ? (
            <Group id="working" label="Working" count={groups.working.length} defaultOpen>
              {groups.working.map(row)}
            </Group>
          ) : null}
          {groups.settled.length > 0 ? (
            <Group id="settled" label="Settled" count={groups.settled.length} defaultOpen={false}>
              {settledRows.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} selected={thread.id === selectedThread} compact />
              ))}
              {groups.settled.length > settledRows.length ? (
                <li>
                  <button type="button" className="show-more" onClick={() => setShowAllSettled(true)}>
                    Show {groups.settled.length - settledRows.length} more
                  </button>
                </li>
              ) : null}
            </Group>
          ) : null}
        </div>
      ) : null}
      <SidebarFoot route={route} />
    </nav>
  );
});
