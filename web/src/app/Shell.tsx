import { PanelLeft } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AddProject } from "../features/onboarding/AddProject";
import { DraftView } from "../features/onboarding/DraftView";
import { TrustFolder } from "../features/onboarding/TrustFolder";
import { SettingsPage } from "../features/settings/SettingsPage";
import { ThreadView } from "../features/thread/ThreadView";
import { CommandPalette } from "../features/workspace/CommandPalette";
import { arrangeThreads, threadsFlat } from "../features/workspace/groups";
import {
  copyText,
  pinThreads,
  settleThreads,
  unpinThreads,
  unsettleThreads,
} from "../features/workspace/threadActions";
import { releaseUndoShortcut, undoHasShortcut, undoLatest, useUndoNotice } from "../features/workspace/threadUndo";
import { Sidebar } from "../features/workspace/Sidebar";
import { Toasts } from "../ui/Toasts";
import { usePanelMotionRoot } from "../lib/panelAnimations";
import { useLayoutWidth } from "../lib/useLayout";
import { navigate, routeHref, useRoute, type Route } from "../state/route";
import { useUi, type ContextTab } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { IconButton } from "../ui/controls";

const POLL_MS = 4000;

function RouteView({ route, needsProject }: { route: Exclude<Route, { name: "settings" }>; needsProject: boolean }) {
  switch (route.name) {
    case "home":
      return needsProject ? <AddProject /> : <DraftView key="draft" projectId={null} />;
    case "thread":
      return <ThreadView key={route.id} id={route.id} />;
    case "new":
      return <DraftView key={route.projectId ?? "draft"} projectId={route.projectId} />;
    case "add-project":
      return <AddProject />;
    case "trust":
      return <TrustFolder projectId={route.projectId} threadId={route.threadId} />;
  }
}

const PANEL_KEYS: Record<string, ContextTab> = {
  Digit1: "diff",
  Digit2: "terminal",
  Digit3: "activity",
};

const editing = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']");

/** The current thread's shortcuts, with their reference defaults. */
function threadKey(event: KeyboardEvent, route: Route): boolean {
  const mod = /mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (!mod) {
    if (!["shift", "meta", "control", "alt"].includes(key)) releaseUndoShortcut();
    return false;
  }
  if (key === "z" && !event.shiftKey && !event.altKey) {
    if (useUndoNotice.getState().notice && (undoHasShortcut() || !editing(event.target))) {
      event.preventDefault();
      void undoLatest();
      return true;
    }
    return false;
  }
  if (key === "b" && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    useUi.getState().toggleSidebar();
    return true;
  }
  if (!event.shiftKey || event.altKey) return false;
  const { threads } = useWorkspace.getState();
  const openId = route.name === "thread" ? route.id : null;
  const current = openId ? threads[openId] : undefined;
  if (key === "[" || key === "]" || event.code === "BracketLeft" || event.code === "BracketRight") {
    const rows = threadsFlat(arrangeThreads(Object.values(threads), Date.now(), openId)).filter(
      (thread) => !thread.lifecycle?.settled_at,
    );
    if (rows.length === 0) return false;
    const at = rows.findIndex((thread) => thread.id === openId);
    const step = event.code === "BracketLeft" ? -1 : 1;
    const next = rows[(at + step + rows.length) % rows.length];
    event.preventDefault();
    if (next) navigate({ name: "thread", id: next.id });
    return true;
  }
  if (!current) return false;
  if (key === "s") {
    event.preventDefault();
    void (current.lifecycle?.settled_at ? unsettleThreads([current]) : settleThreads([current]));
    return true;
  }
  if (key === "p") {
    event.preventDefault();
    void (current.lifecycle?.pinned_at ? unpinThreads([current]) : pinThreads([current]));
    return true;
  }
  if (key === "c") {
    event.preventDefault();
    void copyText(current.id, "Copied thread ID");
    return true;
  }
  return false;
}

function useGlobalKeys(route: Route) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (route.name === "thread" && !document.querySelector("dialog[open]")) {
          const { panelOpen, closePanel } = useUi.getState();
          if (panelOpen === true) closePanel();
        }
        return;
      }
      if (threadKey(event, route)) return;
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.code === "KeyN") {
        event.preventDefault();
        navigate({ name: "new", projectId: null });
      } else if (route.name === "thread" && PANEL_KEYS[event.code]) {
        event.preventDefault();
        useUi.getState().togglePanel(PANEL_KEYS[event.code] ?? "diff");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [route]);
}

/** Moves focus into the new screen, so keyboard and screen reader users follow it. */
function useRouteFocus(routeKey: string, ready: boolean, main: React.RefObject<HTMLElement | null>) {
  const first = useRef(true);
  useEffect(() => {
    if (!ready) return;
    const root = main.current;
    if (!root) return;
    const target =
      root.querySelector<HTMLElement>("[data-autofocus]") ??
      (first.current ? null : root.querySelector<HTMLElement>("[data-page-title]"));
    first.current = false;
    (target ?? root).focus({ preventScroll: true });
    root.scrollTop = 0;
  }, [routeKey, ready, main]);
}

export function Shell() {
  const route = useRoute();
  const layout = useLayoutWidth();
  const projects = useWorkspace((state) => state.projects.data);
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const sidebarWidth = useUi((state) => state.sidebarWidth);
  const behindSettings = useRef<Exclude<Route, { name: "settings" }>>({ name: "home" });
  const main = useRef<HTMLElement>(null);
  const routeKey = routeHref(route);
  const threadReady = useWorkspace((state) => route.name !== "thread" || state.threads[route.id] !== undefined);

  const [paletteOpen, setPaletteOpen] = useState(false);
  useGlobalKeys(route);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  usePanelMotionRoot(routeKey);
  useRouteFocus(routeKey, threadReady, main);

  useEffect(() => {
    const { refreshAll, refreshEngines } = useWorkspace.getState();
    void refreshAll();
    void refreshEngines();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshAll();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const needsProject = projects !== null && projects.length === 0;
  const underneath = route.name === "settings" ? behindSettings.current : route;
  if (route.name !== "settings") behindSettings.current = route;
  const onHome = underneath.name === "home" && !needsProject;
  const showNav = layout === "narrow" ? onHome : !collapsed;

  return (
    <div
      className="shell"
      data-nav={showNav ? "shown" : "hidden"}
      data-layout={layout}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
    >
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        main.current?.focus();
      }}>
        Skip to content
      </a>
      {showNav ? <Sidebar route={route} /> : null}
      <Toasts />
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      {collapsed && layout !== "narrow" && underneath.name !== "thread" ? (
        <IconButton className="expand-nav" label="Expand sidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} aria-hidden />
        </IconButton>
      ) : null}
      {layout === "narrow" && onHome && route.name !== "settings" ? (
        <main id="main" ref={main} tabIndex={-1} hidden />
      ) : (
        <main id="main" ref={main} tabIndex={-1} className="main">
          <RouteView route={underneath} needsProject={needsProject} />
        </main>
      )}
      {route.name === "settings" ? (
        <SettingsPage section={route.section} onClose={() => navigate(underneath)} />
      ) : null}
    </div>
  );
}
