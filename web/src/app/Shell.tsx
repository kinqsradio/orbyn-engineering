import { PanelLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { create } from "zustand";
import { NoProjects } from "../features/onboarding/NoProjects";
import { DraftView } from "../features/onboarding/DraftView";
import { TrustFolder } from "../features/onboarding/TrustFolder";
import { SettingsPage } from "../features/settings/SettingsPage";
import { ThreadView } from "../features/thread/ThreadView";
import { CommandPalette } from "../features/workspace/CommandPalette";
import type { ShellEvent, Thread } from "../api/types";
import { arrangeThreads, threadsFlat } from "../features/workspace/groups";
import {
  copyReference,
  pinThreads,
  settleThreads,
  unpinThreads,
  unsettleThreads,
} from "../features/workspace/threadActions";
import { releaseUndoShortcut, undoHasShortcut, undoLatest, useUndoNotice } from "../features/workspace/threadUndo";
import { Sidebar } from "../features/workspace/Sidebar";
import { PullsPage } from "../features/pulls/PullsPage";
import { UsagePage } from "../features/usage/UsagePage";
import { PreviewFloat } from "../features/panels/PreviewFloat";
import { Toasts } from "../ui/Toasts";
import { api, setSlowRequestHandler } from "../api/client";
import { usePanelMotionRoot } from "../lib/panelAnimations";
import { inDesktopApp, zoomKeyAction } from "../api/shell";
import { toFailure, useAsync } from "../lib/useAsync";
import { FALLBACK_RULES, matchesKey, runHandlers, setTerminalRules, useCommand, whenHolds, type WhenContext } from "./shortcuts";
import { useLayoutWidth } from "../lib/useLayout";
import { navigate, parseRoute, routeHref, useRoute, type Route } from "../state/route";
import { DRAFT_LAYOUT, useUi, type ContextTab, type ThemeChoice } from "../state/ui";
import { useVisibleProjects, useWorkspace } from "../state/workspace";
import { IconButton } from "../ui/controls";

const HIDDEN_POLL_EVERY = 3;
const POLL_MS = 4000;

type PageRoute = Exclude<Route, { name: "settings" | "usage" }>;

function RouteView({ route, needsProject }: { route: PageRoute; needsProject: boolean }) {
  switch (route.name) {
    case "home":
      return needsProject ? <NoProjects /> : <DraftView key="draft" projectId={null} />;
    case "pulls":
      return <PullsPage />;
    case "thread":
      return <ThreadView key={route.id} id={route.id} />;
    case "new":
      return <DraftView key={route.projectId ?? "draft"} projectId={route.projectId} />;
    case "trust":
      return <TrustFolder projectId={route.projectId} threadId={route.threadId} />;
  }
}

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };

const PANEL_KEYS: Record<string, ContextTab> = {
  Digit1: "diff",
  Digit2: "terminal",
  Digit3: "activity",
};

const editing = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']");

const openThread = (route: Route) => {
  const id = route.name === "thread" ? route.id : null;
  return id ? useWorkspace.getState().threads[id] : undefined;
};

function jumpRows(route: Route) {
  const { threads } = useWorkspace.getState();
  const openId = route.name === "thread" ? route.id : null;
  return threadsFlat(arrangeThreads(Object.values(threads), Date.now(), openId)).filter(
    (thread) => !thread.lifecycle?.settled_at,
  );
}

function stepThread(route: Route, step: number): boolean {
  const rows = jumpRows(route);
  if (rows.length === 0) return false;
  const at = rows.findIndex((thread) => route.name === "thread" && thread.id === route.id);
  const next = rows[(at + step + rows.length) % rows.length];
  if (next) navigate({ name: "thread", id: next.id });
  return true;
}

/** Commands the shell owns; the rest belong to whatever registered for them. */
function runShellCommand(command: string, route: Route): boolean {
  const ui = useUi.getState();
  const thread = openThread(route);
  const jump = /^thread\.jump\.(\d)$/.exec(command);
  if (jump) {
    const row = jumpRows(route)[Number(jump[1]) - 1];
    if (row) navigate({ name: "thread", id: row.id });
    return row !== undefined;
  }
  switch (command) {
    case "sidebar.toggle":
      ui.toggleSidebar();
      return true;
    case "commandPalette.toggle":
      ui.setPalette(ui.palette ? null : "root");
      return true;
    case "usage.open":
      navigate({ name: "usage" });
      return true;
    case "settings.open":
      navigate({ name: "settings", section: null });
      return true;
    case "updates.check":
      navigate({ name: "settings", section: "maintenance" });
      api.checkUpdates().then(
        (status) => useWorkspace.getState().putUpdates(status),
        (failure: unknown) => ui.pushToast(`Couldn't check for updates. ${toFailure(failure).message}`),
      );
      return true;
    case "appearance.cycle":
      ui.setTheme(NEXT_THEME[ui.theme]);
      return true;
    case "theme.select":
    case "themeEditor.toggle":
      navigate(route.name === "settings" ? { name: "home" } : { name: "settings", section: "appearance" });
      return true;
    case "filePicker.toggle":
      if (route.name !== "thread") return false;
      ui.setPalette(ui.palette ? null : "files");
      return true;
    case "projectSearch.toggle":
      if (route.name !== "thread") return false;
      ui.setPalette(ui.palette ? null : "search");
      return true;
    case "navigation.back":
      window.history.back();
      return true;
    case "navigation.forward":
      window.history.forward();
      return true;
    case "chat.new":
    case "chat.newLocal":
      navigate({ name: "new", projectId: thread?.project_id ?? null });
      return true;
    case "chat.newWithoutProject":
      navigate({ name: "new", projectId: null });
      return true;
    case "workspace.focusNext":
      return cycleFocus(1);
    case "workspace.focusPrevious":
      return cycleFocus(-1);
    case "thread.previous":
      return stepThread(route, -1);
    case "thread.next":
      return stepThread(route, 1);
    default:
      break;
  }
  if (route.name !== "thread") return false;
  switch (command) {
    case "preview.toggle":
      useUi.getState().togglePanel("browser");
      return true;
    case "terminal.toggle":
      ui.togglePanel("terminal");
      return true;
    case "diff.toggle":
      ui.togglePanel("diff");
      return true;
    case "rightPanel.toggle":
      ui.setPanelOpen(ui.panelOpen !== true);
      return true;
    case "rightPanel.close":
      if (ui.panelOpen !== true) return false;
      ui.closePanel();
      return true;
    case "threadPanel.toggle":
      ui.toggleDetails();
      return true;
    case "thread.stop":
      if (!thread?.active_run) return false;
      void api.cancelRun(thread.active_run.id);
      return true;
    case "thread.settle":
      if (!thread) return false;
      void (thread.lifecycle?.settled_at ? unsettleThreads([thread]) : settleThreads([thread]));
      return true;
    case "thread.pin":
      if (!thread) return false;
      void (thread.lifecycle?.pinned_at ? unpinThreads([thread]) : pinThreads([thread]));
      return true;
    case "thread.copyReference":
      if (!thread) return false;
      void copyReference(thread);
      return true;
    default:
      return false;
  }
}

/** The window's main areas, for moving between them without a pointer. */
const FOCUS_AREAS = [
  "nav[aria-label='Workspace'] .thread-row a, nav[aria-label='Workspace'] a",
  ".transcript, [aria-label='Thread messages']",
  ".composer textarea",
  "[aria-label='Thread context'] button, .details button",
];

function cycleFocus(step: number): boolean {
  const areas = FOCUS_AREAS.map((selector) => document.querySelector<HTMLElement>(selector)).filter((area) => area !== null);
  if (areas.length === 0) return false;
  const current = areas.findIndex((area, at) => {
    const selector = FOCUS_AREAS[at] ?? "";
    return area === document.activeElement || document.activeElement?.closest(selector.split(",")[0]?.split(" ")[0] ?? "") != null;
  });
  const next = areas[(current + step + areas.length) % areas.length];
  if (next && !next.hasAttribute("tabindex") && next.tagName === "DIV") next.tabIndex = -1;
  next?.focus();
  return true;
}

function keyContext(route: Route): WhenContext {
  const active = document.activeElement;
  const ui = useUi.getState();
  return {
    terminalFocus: active?.closest(".terminal-drawer-body") != null,
    previewFocus: active?.closest("[data-preview]") != null,
    composerFocus: active?.closest(".composer") != null,
    editableFocus: editing(active),
    rightPanelOpen: ui.panelOpen === true,
    usagePageOpen: route.name === "usage",
    turnRunning: openThread(route)?.active_run != null,
    draftRoute: route.name === "new" || route.name === "home",
  };
}

/** The undo shortcut outranks everything while its notice shows. */
function undoKey(event: KeyboardEvent): boolean {
  const mod = /mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (!mod) {
    if (!["shift", "meta", "control", "alt"].includes(key)) releaseUndoShortcut();
    return false;
  }
  if (key !== "z" || event.shiftKey || event.altKey) return false;
  if (useUndoNotice.getState().notice && (undoHasShortcut() || !editing(event.target))) {
    event.preventDefault();
    void undoLatest();
    return true;
  }
  return false;
}

/** Read out by screen readers when another thread changes. */
const useAnnouncer = create<{ text: string }>(() => ({ text: "" }));

function BackgroundAnnouncer() {
  const text = useAnnouncer((state) => state.text);
  return (
    <div className="sr-only" role="status" aria-label="Background threads">
      {text}
    </div>
  );
}

type Attention = "working" | "waiting" | "done" | "failed" | "idle";

const attentionOf = (thread: Thread): Attention =>
  thread.active_run?.state === "awaiting_approval"
    ? "waiting"
    : thread.active_run
      ? "working"
      : thread.last_run_state === "failed"
        ? "failed"
        : thread.last_run_state === "completed"
          ? "done"
          : "idle";

const notices: Partial<Record<Attention, string>> = {
  waiting: "needs your approval",
  done: "finished",
  failed: "failed",
};

/** A short tone. Browsers refuse audio before a first click, which costs nothing here. */
function playChime() {
  try {
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const level = audio.createGain();
    tone.frequency.value = 660;
    level.gain.setValueAtTime(0.06, audio.currentTime);
    level.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
    tone.connect(level).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + 0.18);
    tone.onended = () => void audio.close();
  } catch {
    // No audio device. The other notices still go out.
  }
}

/** Tells you when another thread finishes, fails or needs you. */
function useThreadNotifications(openId: string | null) {
  useEffect(() => {
    const seen = new Map<string, Attention>();
    return useWorkspace.subscribe((state) => {
      for (const thread of Object.values(state.threads)) {
        const now = attentionOf(thread);
        const before = seen.get(thread.id);
        seen.set(thread.id, now);
        const notice = notices[now];
        if (before === undefined || before === now || !notice || thread.id === openId) continue;
        useAnnouncer.setState({ text: `${thread.title} ${notice}` });
        const { inAppNotifications, threadNotifications, threadSound, pushToast } = useUi.getState();
        if (inAppNotifications) pushToast(`${thread.title} ${notice}`);
        if (threadSound) playChime();
        if (threadNotifications && document.hidden && "Notification" in window && Notification.permission === "granted") {
          new Notification(thread.title, { body: notice });
        }
      }
    });
  }, [openId]);
}

const SLOW_TOAST_GAP_MS = 60_000;

/** Says so when the service is slow, once a minute at most. */
function useSlowRequestToast() {
  useEffect(() => {
    let last = 0;
    setSlowRequestHandler(() => {
      if (Date.now() - last < SLOW_TOAST_GAP_MS) return;
      last = Date.now();
      useUi.getState().pushToast("The Orbyn service is taking a while to answer.");
    });
    return () => setSlowRequestHandler(() => undefined);
  }, []);
}

function useGlobalKeys(route: Route) {
  useSlowRequestToast();
  const keymap = useAsync("keybindings", (signal) => api.keybindings(signal));
  const reload = keymap.reload;
  useCommand("keybindings.reload", reload);
  const rules = keymap.data?.rules ?? FALLBACK_RULES;
  useEffect(() => setTerminalRules(rules), [rules]);
  const pushToast = useUi((state) => state.pushToast);
  const seenFile = useRef<string | null>(null);
  useEffect(() => {
    const data = keymap.data;
    if (!data) return;
    const signature = JSON.stringify([data.rules, data.issues]);
    if (data.issues.length > 0 && signature !== seenFile.current) pushToast(`The keybindings file has a problem. ${data.issues[0] ?? ""}`);
    else if (seenFile.current !== null && signature !== seenFile.current) pushToast("Keybindings reloaded");
    seenFile.current = signature;
  }, [keymap.data, pushToast]);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (route.name === "thread" && !document.querySelector("dialog[open]")) {
          const { panelOpen, closePanel } = useUi.getState();
          if (panelOpen === true) closePanel();
        }
        return;
      }
      if (undoKey(event)) return;
      const zoom = inDesktopApp() ? zoomKeyAction(event) : null;
      if (zoom) {
        event.preventDefault();
        api.shellAction(zoom).catch(() => undefined);
        return;
      }
      // A focused surface that took the key, like the model picker's number jumps, keeps it.
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || /^F\d+$/.test(event.key)) {
        const context = keyContext(route);
        // The last rule wins, so the file overrides a default.
        for (const rule of [...rules].reverse()) {
          if (rule.remove || !matchesKey(rule.key, event) || !whenHolds(rule.when, context)) continue;
          if (runHandlers(rule.command) || runShellCommand(rule.command, route)) {
            event.preventDefault();
            return;
          }
        }
      }
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        if (runShellCommand(`thread.jump.${digit[1]}`, route)) event.preventDefault();
        return;
      }
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
  }, [route, rules]);
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

/** Links and menu items from the desktop shell, which behave like keys pressed here. */
export function onShellEvent(event: ShellEvent) {
  if (event.type === "navigate") {
    window.location.hash = event.href.slice(1);
    return;
  }
  if (!runHandlers(event.command)) runShellCommand(event.command, parseRoute(window.location.hash));
}

export function Shell() {
  const route = useRoute();
  const layout = useLayoutWidth();
  const projects = useVisibleProjects();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const sidebarWidth = useUi((state) => state.sidebarWidth);
  const behindSettings = useRef<PageRoute>({ name: "home" });
  const main = useRef<HTMLElement>(null);
  const routeKey = routeHref(route);
  const threadReady = useWorkspace((state) => route.name !== "thread" || state.threads[route.id] !== undefined);

  const layoutKey =
    route.name === "thread" ? route.id : route.name === "new" || route.name === "home" ? DRAFT_LAYOUT : null;
  useLayoutEffect(() => {
    if (layoutKey) useUi.getState().setLayoutKey(layoutKey);
  }, [layoutKey]);
  const palette = useUi((state) => state.palette);
  const setPalette = useUi((state) => state.setPalette);
  useGlobalKeys(route);
  useThreadNotifications(route.name === "thread" ? route.id : null);
  usePanelMotionRoot(routeKey);
  useRouteFocus(routeKey, threadReady, main);

  useEffect(() => {
    const { refreshAll, refreshEngines } = useWorkspace.getState();
    void refreshAll();
    void refreshEngines();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      // A hidden window keeps up while work runs, or its alerts would never fire, and
      // looks in now and then so it hears of work started elsewhere.
      const running = Object.values(useWorkspace.getState().threads).some((thread) => thread.active_run);
      if (!document.hidden || running || ticks % HIDDEN_POLL_EVERY === 0) void refreshAll();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const needsProject = projects !== null && projects.length === 0;
  const overlay = route.name === "settings" || route.name === "usage";
  const underneath = overlay ? behindSettings.current : route;
  if (!overlay) behindSettings.current = route;
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
      <BackgroundAnnouncer />
      <PreviewFloat threadId={route.name === "thread" ? route.id : null} />
      <Toasts />
      {palette ? <CommandPalette start={palette} onClose={() => setPalette(null)} /> : null}
      {collapsed && layout !== "narrow" && underneath.name !== "thread" ? (
        <IconButton className="expand-nav" label="Expand sidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} aria-hidden />
        </IconButton>
      ) : null}
      {layout === "narrow" && onHome && !overlay ? (
        <main id="main" ref={main} tabIndex={-1} hidden />
      ) : (
        <main id="main" ref={main} tabIndex={-1} className="main">
          <RouteView route={underneath} needsProject={needsProject} />
        </main>
      )}
      {route.name === "usage" ? <UsagePage onClose={() => navigate(underneath)} /> : null}
      {route.name === "settings" ? (
        <SettingsPage section={route.section} onClose={() => navigate(underneath)} />
      ) : null}
    </div>
  );
}
