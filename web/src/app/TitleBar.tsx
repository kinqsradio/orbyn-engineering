import { PanelLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { inDesktopApp, onShellChange, readShellStatus } from "../api/shell";
import { attentionRank } from "../features/workspace/groups";
import { EnvironmentIdentity } from "../features/workspace/EnvironmentIdentity";
import { useAsync } from "../lib/useAsync";
import { routeHref, type Route } from "../state/route";
import { useUi } from "../state/ui";
import { useVisibleProjects, useWorkspace } from "../state/workspace";
import { ProjectBadge } from "../ui/badges";
import { IconButton } from "../ui/controls";

/** True in the desktop app on macOS, where the window's traffic lights sit over the title bar. */
function useTrafficLights(): boolean {
  const [attached, setAttached] = useState(inDesktopApp());
  const info = useAsync("environment-identity", (signal) => api.info(signal));
  useEffect(() => {
    let live = true;
    const read = () => void readShellStatus().then(() => live && setAttached(inDesktopApp()), () => undefined);
    read();
    const stop = onShellChange(read);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return attached && info.data?.platform === "macos";
}

/** Threads waiting on the person: an approval, a question or a limit. */
function useWaitingCount(): number {
  const threads = useWorkspace((state) => state.threads);
  return useMemo(
    () =>
      Object.values(threads).filter(
        (thread) =>
          !thread.lifecycle?.archived_at &&
          !thread.lifecycle?.settled_at &&
          thread.lifecycle?.relation !== "side" &&
          attentionRank(thread) === 0,
      ).length,
    [threads],
  );
}

/** The window's top line: the brand, the page it is on and page-level status. */
export function TitleBar({ route, narrow }: { route: Route; narrow: boolean }) {
  const lights = useTrafficLights();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const ledger = useUi((state) => state.workspaceLayout === "ledger");
  const projects = useVisibleProjects();
  const thread = useWorkspace((state) => (route.name === "thread" ? state.threads[route.id] : undefined));
  const waiting = useWaitingCount();
  const projectId =
    route.name === "thread" ? thread?.project_id : route.name === "new" ? route.projectId : null;
  const project = projectId ? (projects?.find((p) => p.id === projectId) ?? null) : null;

  const page =
    route.name === "thread"
      ? null
      : route.name === "pulls"
        ? "Pull requests"
        : route.name === "usage"
          ? "Usage"
          : route.name === "settings"
            ? "Settings"
            : route.name === "trust"
              ? "Trust folder"
              : "New thread";

  return (
    <header className="titlebar" data-tauri-drag-region>
      {lights ? <span className="titlebar-lights" aria-hidden /> : null}
      {narrow ? null : (
        <IconButton label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleSidebar}>
          <PanelLeft size={16} aria-hidden />
        </IconButton>
      )}
      <a className="titlebar-brand" href={routeHref({ name: "home" })} title="Orbyn Engineering">
        Orbyn
      </a>
      <span className="titlebar-page">
        {project ? <ProjectBadge name={project.name} project={project} /> : null}
        <span className="titlebar-page-label">
          {route.name === "thread" ? (project?.name ?? "") : route.name === "new" && project ? `${project.name} / ${page}` : page}
        </span>
      </span>
      <span className="titlebar-end">
        <EnvironmentIdentity />
        {ledger && waiting > 0 ? (
          <span className="titlebar-waiting" role="status">
            <span className="status-dot" aria-hidden />
            {waiting} waiting on you
          </span>
        ) : null}
      </span>
    </header>
  );
}
