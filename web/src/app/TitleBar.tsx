import { ChevronLeft, ChevronRight, FileDiff, PanelLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { inDesktopApp, onShellChange, readShellStatus } from "../api/shell";
import { attentionRank } from "../features/workspace/groups";
import { EnvironmentIdentity } from "../features/workspace/EnvironmentIdentity";
import { useThreadLogs } from "../features/thread/threadLogs";
import { useAsync } from "../lib/useAsync";
import { labels } from "../features/settings/SettingsPage";
import { navigate, type Route } from "../state/route";
import { usePageLabel } from "../state/pageLabel";
import { useReadingNav } from "./readingNav";
import { toggleSidebarDrawer, useSidebarDrawer } from "./sidebarDrawer";
import type { LayoutWidth } from "../lib/useLayout";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { goBack, goForward, useNavHistory } from "./navHistory";

const INTERACTIVE =
  "a,button,input,select,textarea,summary,label,[role=button],[role=tab],[role=menuitem],[contenteditable=true],[tabindex]:not([tabindex='-1'])";

/**
 * The whole top strip drags the window, but the bar floats over the page, so its own box
 * would swallow clicks on the page's buttons beneath. The drag layer therefore takes the
 * pointer only while nothing interactive is under it.
 */
function useDragStrip(layer: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const node = layer.current;
      if (!node) return;
      const strip = node.getBoundingClientRect();
      if (event.clientY < strip.top || event.clientY > strip.bottom) {
        node.removeAttribute("data-hot");
        return;
      }
      const under = document.elementsFromPoint?.(event.clientX, event.clientY).find((element) => element !== node);
      if (under?.closest(INTERACTIVE) && !node.contains(under)) node.removeAttribute("data-hot");
      else node.setAttribute("data-hot", "");
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => document.removeEventListener("pointermove", onMove);
  }, [layer]);
}

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

/** Reading's way to the changes: the diff opens in the side drawer. */
function ReadingDiff({ threadId }: { threadId: string }) {
  const version = useThreadLogs((state) => state.diffVersion[threadId] ?? 0);
  const diff = useAsync(`details-diff:${threadId}`, (signal) => api.diff(threadId, signal));
  const { reload } = diff;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else void reload();
  }, [version, reload]);
  const showing = useUi((state) => state.panelOpen === true && state.panelTab === "diff");
  const togglePanel = useUi((state) => state.togglePanel);
  const closePanel = useUi((state) => state.closePanel);
  const files = diff.data ?? [];
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <button type="button" className="titlebar-diff" aria-pressed={showing} onClick={() => (showing ? closePanel() : togglePanel("diff"))}>
      <FileDiff size={13} aria-hidden />
      Diff <span className="diff-add">+{added}</span> <span className="diff-del">−{removed}</span>
    </button>
  );
}

/** The window's top line: the brand, the page it is on and page-level status. */
export function TitleBar({ route, layout }: { route: Route; layout: LayoutWidth }) {
  const phone = layout === "phone";
  const small = layout === "small";
  const drawerOpen = useSidebarDrawer((state) => state.open);
  const lights = useTrafficLights();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const reading = useUi((state) => state.workspaceLayout === "reading");
  const readingNav = useReadingNav((state) => state.open);
  const toggleReadingNav = useReadingNav((state) => state.toggle);
  const ledger = useUi((state) => state.workspaceLayout === "ledger");
  const title = useWorkspace((state) => (route.name === "thread" ? state.threads[route.id]?.title : undefined));
  const waiting = useWaitingCount();
  const pageLabel = usePageLabel((state) => state.label);

  const page =
    route.name === "thread"
      ? (title ?? "")
      : route.name === "pulls"
        ? (pageLabel ?? "Pull requests")
        : route.name === "usage"
          ? "Usage"
          : route.name === "tasks"
            ? "Scheduled tasks"
            : route.name === "settings"
              ? labels[route.section ?? "general"]
              : route.name === "trust"
                ? "Trust folder"
                : "New thread";
  const shown = small ? drawerOpen : reading ? readingNav : !collapsed;
  // Folding the sidebar away must not strand focus on a row that no longer exists.
  const wasShown = useRef(shown);
  useEffect(() => {
    if (wasShown.current && !shown && (!document.activeElement || document.activeElement === document.body)) {
      document.querySelector<HTMLElement>("[data-sidebar-toggle]")?.focus();
    }
    wasShown.current = shown;
  }, [shown]);

  const trail = useNavHistory();
  const dragLayer = useRef<HTMLDivElement>(null);
  useDragStrip(dragLayer);
  const sidebarLabel = shown ? "Hide sidebar" : "Show sidebar";

  return (
    <header className="titlebar" data-nav={shown && !small ? "shown" : "hidden"} data-tauri-drag-region>
      <div ref={dragLayer} className="titlebar-drag" data-tauri-drag-region aria-hidden />
      {lights ? <span className="titlebar-lights" aria-hidden /> : null}
      <button
        type="button"
        className="tbi"
        aria-label={sidebarLabel}
        aria-expanded={shown}
        data-sidebar-toggle
        onClick={
          phone
            ? // On the phone the sidebar is the home page: it opens by going home and closes by leaving it.
              () => navigate(shown ? { name: "new", projectId: null } : { name: "home" })
            : small
              ? // On a small window it is a drawer over the thread.
                toggleSidebarDrawer
              : reading
                ? toggleReadingNav
                : toggleSidebar
        }
      >
        <PanelLeft size={16} aria-hidden />
      </button>
      <button type="button" className="tbi" aria-label="Back" aria-disabled={!trail.back} data-dim={!trail.back || undefined} onClick={() => trail.back && goBack()}>
        <ChevronLeft size={16} aria-hidden />
      </button>
      <button type="button" className="tbi" aria-label="Forward" aria-disabled={!trail.forward} data-dim={!trail.forward || undefined} onClick={() => trail.forward && goForward()}>
        <ChevronRight size={16} aria-hidden />
      </button>
      {shown ? null : (
        <span className="titlebar-title" title="Orbyn Engineering">
          <b>Orbyn</b>
          <span className="titlebar-page-label"> · {page}</span>
        </span>
      )}
      <span className="titlebar-end">
        <EnvironmentIdentity />
        {reading && route.name === "thread" ? <ReadingDiff threadId={route.id} /> : null}
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
