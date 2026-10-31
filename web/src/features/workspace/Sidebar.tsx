import { ChevronRight, FolderPlus, Plus, Settings, ShieldAlert } from "lucide-react";
import { memo, useState } from "react";
import type { Project } from "../../api/types";
import { relativeTime } from "../../lib/format";
import { routeHref, type Route } from "../../state/route";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { IconButton, LinkButton, Pill } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { ApprovalsLink } from "./ApprovalsLink";
import { RunStateIcon, threadRunState } from "./RunState";

const INITIAL_THREADS = 8;

function ThreadRow({ id, selected }: { id: string; selected: boolean }) {
  const thread = useWorkspace((state) => state.threads[id]);
  const unmanaged = useWorkspace(
    (state) =>
      thread !== undefined &&
      engineById(state.engines.data, thread.engine)?.capabilities.managed === false,
  );
  if (!thread) return null;
  return (
    <li>
      <a
        className="thread-row"
        href={routeHref({ name: "thread", id })}
        aria-current={selected ? "page" : undefined}
      >
        <RunStateIcon state={threadRunState(thread)} />
        <span className="thread-row-title">{thread.title}</span>
        {unmanaged ? (
          <Pill tone="warn">Unmanaged</Pill>
        ) : (
          <time className="thread-row-time" dateTime={thread.updated_at}>
            {relativeTime(thread.updated_at)}
          </time>
        )}
      </a>
    </li>
  );
}

function ProjectGroup({ project, selectedThread }: { project: Project; selectedThread: string | null }) {
  const threads = useWorkspace((state) => state.threadIds[project.id]);
  const refreshThreads = useWorkspace((state) => state.refreshThreads);
  const collapsed = useUi((state) => state.collapsed[project.id] ?? false);
  const toggle = useUi((state) => state.toggleProject);
  const [showAll, setShowAll] = useState(false);
  const ids = threads?.data ?? [];
  const selectedAt = selectedThread ? ids.indexOf(selectedThread) : -1;
  const limit = showAll ? ids.length : Math.max(INITIAL_THREADS, selectedAt + 1);
  const visible = ids.slice(0, limit);

  return (
    <section className="project">
      <div className="project-head">
        <button
          type="button"
          className="project-toggle"
          aria-expanded={!collapsed}
          onClick={() => toggle(project.id)}
          title={project.path}
        >
          <ChevronRight size={16} className="chev" aria-hidden />
          <span className="project-name">{project.name}</span>
        </button>
        {project.trusted ? null : (
          <a
            className="icon-btn icon-warn"
            href={routeHref({ name: "trust", projectId: project.id, threadId: null })}
            aria-label={`Review trust for ${project.name}`}
            title="Folder not trusted"
          >
            <ShieldAlert size={16} aria-hidden />
          </a>
        )}
        <a
          className="icon-btn"
          href={routeHref({ name: "new", projectId: project.id })}
          aria-label={`New thread in ${project.name}`}
          title="New thread"
        >
          <Plus size={16} aria-hidden />
        </a>
      </div>
      {collapsed ? null : threads?.error && !threads.data ? (
        <ErrorState
          compact
          title="Couldn't load threads"
          failure={threads.error}
          onRetry={() => void refreshThreads(project.id)}
        />
      ) : !threads?.data ? (
        <Loading label="Loading threads" rows={2} />
      ) : ids.length === 0 ? (
        <p className="sidebar-empty">No threads yet</p>
      ) : (
        <>
          <ul className="thread-list">
            {visible.map((id) => (
              <ThreadRow key={id} id={id} selected={id === selectedThread} />
            ))}
          </ul>
          {ids.length > visible.length ? (
            <button type="button" className="show-more" onClick={() => setShowAll(true)}>
              Show {ids.length - visible.length} more
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

export const Sidebar = memo(function Sidebar({ route }: { route: Route }) {
  const projects = useWorkspace((state) => state.projects);
  const refreshAll = useWorkspace((state) => state.refreshAll);
  const selectedThread = route.name === "thread" ? route.id : null;
  const list = projects.data ?? [];

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="sidebar-top">
        <a className="brand" href={routeHref({ name: "home" })}>
          <span className="brand-mark" aria-hidden />
          Orbyn Engineering
        </a>
      </div>
      <div className="sidebar-actions">
        <LinkButton
          small
          tone="primary"
          href={routeHref({ name: "new", projectId: null })}
          icon={<Plus size={16} aria-hidden />}
        >
          New thread
        </LinkButton>
        <ApprovalsLink current={route.name === "approvals"} />
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <h2>Projects</h2>
          <IconButton label="Add project" onClick={() => (window.location.hash = routeHref({ name: "add-project" }).slice(1))}>
            <FolderPlus size={16} aria-hidden />
          </IconButton>
        </div>
        {projects.error && !projects.data ? (
          <ErrorState compact title="Couldn't load projects" failure={projects.error} onRetry={() => void refreshAll()} />
        ) : !projects.data ? (
          <Loading label="Loading projects" rows={5} />
        ) : (
          list.map((project) => (
            <ProjectGroup key={project.id} project={project} selectedThread={selectedThread} />
          ))
        )}
      </div>
      <div className="sidebar-foot">
        <a
          className="nav-row"
          href={routeHref({ name: "settings", section: null })}
          aria-current={route.name === "settings" ? "page" : undefined}
        >
          <Settings size={16} aria-hidden />
          <span>Settings</span>
        </a>
      </div>
    </nav>
  );
});
