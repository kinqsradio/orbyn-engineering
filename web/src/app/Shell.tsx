import { PanelLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { AddProject } from "../features/onboarding/AddProject";
import { NewThread } from "../features/onboarding/NewThread";
import { TrustFolder } from "../features/onboarding/TrustFolder";
import { SettingsPage } from "../features/settings/SettingsPage";
import { ThreadView } from "../features/thread/ThreadView";
import { ApprovalsPage, HomePage } from "../features/workspace/Attention";
import { Sidebar } from "../features/workspace/Sidebar";
import { usePanelAnimationAttribute } from "../lib/panelAnimations";
import { useLayoutWidth } from "../lib/useLayout";
import { navigate, routeHref, useRoute, type Route } from "../state/route";
import { useUi, type ContextTab } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { IconButton } from "../ui/controls";

const POLL_MS = 4000;
const UPDATE_CHECK_MS = 6 * 3_600_000;

function RouteView({ route, needsProject }: { route: Route; needsProject: boolean }) {
  switch (route.name) {
    case "home":
      return needsProject ? <AddProject /> : <HomePage />;
    case "approvals":
      return <ApprovalsPage />;
    case "thread":
      return <ThreadView key={route.id} id={route.id} />;
    case "new":
      return <NewThread projectId={route.projectId} />;
    case "add-project":
      return <AddProject />;
    case "trust":
      return <TrustFolder projectId={route.projectId} threadId={route.threadId} />;
    case "settings":
      return <SettingsPage section={route.section} />;
  }
}

const PANEL_KEYS: Record<string, ContextTab> = {
  Digit1: "diff",
  Digit2: "terminal",
  Digit3: "activity",
};

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
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.code === "KeyN") {
        event.preventDefault();
        navigate({ name: "new", projectId: null });
      } else if (event.code === "KeyA") {
        event.preventDefault();
        navigate({ name: "approvals" });
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
  const pending = useWorkspace((state) => state.approvals.data?.length ?? 0);
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const backgroundChecks = useUi((state) => state.backgroundChecks);
  const main = useRef<HTMLElement>(null);
  const routeKey = routeHref(route);
  const threadReady = useWorkspace((state) => route.name !== "thread" || state.threads[route.id] !== undefined);

  useGlobalKeys(route);
  usePanelAnimationAttribute(routeKey);
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

  useEffect(() => {
    if (!backgroundChecks) return;
    const check = () => {
      if (document.hidden) return;
      api.checkUpdates().then(
        (status) => useWorkspace.getState().putUpdates(status),
        () => undefined,
      );
    };
    const timer = setInterval(check, UPDATE_CHECK_MS);
    return () => clearInterval(timer);
  }, [backgroundChecks]);

  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) Orbyn Engineering` : "Orbyn Engineering";
  }, [pending]);

  const needsProject = projects !== null && projects.length === 0;
  const onHome = route.name === "home" && !needsProject;
  const showNav = layout === "narrow" ? onHome : !collapsed;

  return (
    <div className="shell" data-nav={showNav ? "shown" : "hidden"} data-layout={layout}>
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        main.current?.focus();
      }}>
        Skip to content
      </a>
      {showNav ? <Sidebar route={route} /> : null}
      {collapsed && layout !== "narrow" && route.name !== "thread" ? (
        <IconButton className="expand-nav" label="Expand sidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} aria-hidden />
        </IconButton>
      ) : null}
      {layout === "narrow" && onHome ? (
        <main id="main" ref={main} tabIndex={-1} hidden />
      ) : (
        <main id="main" ref={main} tabIndex={-1} className="main">
          <RouteView route={route} needsProject={needsProject} />
        </main>
      )}
    </div>
  );
}
