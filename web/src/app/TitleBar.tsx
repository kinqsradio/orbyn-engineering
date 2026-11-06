import { PanelLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { inDesktopApp, onShellChange, readShellStatus } from "../api/shell";
import { attentionRank } from "../features/workspace/groups";
import { EnvironmentIdentity } from "../features/workspace/EnvironmentIdentity";
import { useAsync } from "../lib/useAsync";
import { labels } from "../features/settings/SettingsPage";
import { routeHref, type Route } from "../state/route";
import { useReadingNav } from "./readingNav";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
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
  const reading = useUi((state) => state.workspaceLayout === "reading");
  const readingNav = useReadingNav((state) => state.open);
  const toggleReadingNav = useReadingNav((state) => state.toggle);
  const ledger = useUi((state) => state.workspaceLayout === "ledger");
  const title = useWorkspace((state) => (route.name === "thread" ? state.threads[route.id]?.title : undefined));
  const waiting = useWaitingCount();

  const page =
    route.name === "thread"
      ? (title ?? "")
      : route.name === "pulls"
        ? "Pull requests"
        : route.name === "usage"
          ? "Usage"
          : route.name === "settings"
            ? labels[route.section ?? "general"]
            : route.name === "trust"
              ? "Trust folder"
              : "New thread";
  const shown = reading ? readingNav : !collapsed;

  return (
    <header className="titlebar" data-tauri-drag-region>
      {lights ? <span className="titlebar-lights" aria-hidden /> : null}
      {narrow ? null : (
        <IconButton label={shown ? "Collapse sidebar" : "Expand sidebar"} onClick={reading ? toggleReadingNav : toggleSidebar}>
          <PanelLeft size={16} aria-hidden />
        </IconButton>
      )}
      <a className="titlebar-brand" href={routeHref({ name: "home" })} title="Orbyn Engineering">
        Orbyn
      </a>
      <span className="titlebar-page">
        <span className="titlebar-page-label">{page}</span>
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
