import {
  ArrowUp,
  BarChart3,
  ChevronRight,
  CircleDashed,
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
  Hand,
  Unplug,
} from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import type { Project, Thread } from "../../api/types";
import { compactAge, elapsed } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { routeHref, type Route } from "../../state/route";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { EngineGlyph, OrbynMark, ProjectBadge } from "../../ui/badges";
import { IconButton, Pill } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { ApprovalsLink } from "./ApprovalsLink";
import { groupThreads } from "./groups";

const DONE_WINDOW_MS = 5 * 60_000;

function RowStatus({ thread }: { thread: Thread }) {
  const active = thread.active_run;
  const now = useNow(active !== null);
  if (active) {
    const waiting = active.state === "awaiting_approval";
    const Icon = waiting ? Hand : CircleDashed;
    const label = active.state === "admitted" ? "Queued" : waiting ? "Waiting" : "Working";
    return (
      <span className={`row-status ${waiting ? "tone-warn" : "tone-info"}`}>
        <Icon size={14} aria-hidden />
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
  if (state === "completed" && Date.now() - new Date(thread.updated_at).getTime() < DONE_WINDOW_MS) {
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

function ThreadRow({ thread, selected }: { thread: Thread; selected: boolean }) {
  const project = useWorkspace((state) =>
    state.projects.data?.find((p) => p.id === thread.project_id),
  );
  const engine = useWorkspace((state) => engineById(state.engines.data, thread.engine));
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.projects.find((p) => p.id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const unmanaged = engine?.capabilities.managed === false;
  const projectName = project?.name ?? "Unknown project";
  return (
    <li>
      <a
        className="thread-row"
        href={routeHref({ name: "thread", id: thread.id })}
        aria-current={selected ? "page" : undefined}
      >
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
          <EngineGlyph name={engine?.name ?? thread.engine} />
        </span>
      </a>
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
    <section className="group">
      <button type="button" className="group-head" aria-expanded={open} onClick={() => toggle(id, defaultOpen)}>
        <span>{label}</span>
        <span className="group-count">{count}</span>
        <ChevronRight size={14} className="chev" aria-hidden />
      </button>
      {open ? <ul className="thread-list group-list">{children}</ul> : null}
    </section>
  );
}

function SidebarFoot({ route }: { route: Route }) {
  const updates = useWorkspace(
    (state) =>
      state.engines.data?.filter(
        (engine) => engine.update_command && engine.latest && engine.latest !== engine.version,
      ).length ?? 0,
  );
  const settingsHref = routeHref({ name: "settings", section: null });
  return (
    <div className="sidebar-foot">
      <a
        className="icon-btn"
        href={settingsHref}
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
      {updates > 0 ? (
        <a
          className="update-btn"
          href={routeHref({ name: "settings", section: "engines" })}
          aria-label={updates === 1 ? "1 engine update available" : `${updates} engine updates available`}
          title="Engine updates"
        >
          <ArrowUp size={14} aria-hidden />
        </a>
      ) : null}
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
  const row = (thread: Thread) => (
    <ThreadRow key={thread.id} thread={thread} selected={thread.id === selectedThread} />
  );

  return (
    <nav className="sidebar" aria-label="Workspace">
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
          <ul className="thread-list">
            {groups.recent.map(row)}
            {filtering ? null : emptyProjects.map((project) => <EmptyProjectRow key={project.id} project={project} />)}
          </ul>
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
              {groups.settled.map(row)}
            </Group>
          ) : null}
        </div>
      ) : null}
      <SidebarFoot route={route} />
    </nav>
  );
});
