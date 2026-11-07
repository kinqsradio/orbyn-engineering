import { WelcomeHost } from "../features/onboarding/WelcomeWizard";
import { QuitConfirmation } from "../features/workspace/QuitConfirmation";
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
import { CloneJobs } from "../features/workspace/CloneJobs";
import { Sidebar } from "../features/workspace/Sidebar";
import { useDrawnOrder } from "../features/workspace/drawnOrder";
import { PullsPage } from "../features/pulls/PullsPage";
import { ScheduledTasksPage } from "../features/settings/ScheduledTasks";
import { UsagePage } from "../features/usage/UsagePage";
import { PreviewFloat } from "../features/panels/PreviewFloat";
import { Toasts } from "../ui/Toasts";
import { GitHubStarPrompt } from "../features/workspace/GitHubStarPrompt";
import { FoldersNotice } from "../features/workspace/FoldersNotice";
import { api, setSlowRequestHandler } from "../api/client";
import { usePanelMotionRoot } from "../lib/panelAnimations";
import { inDesktopApp, shellChanged, zoomKeyAction } from "../api/shell";
import { toFailure, useAsync } from "../lib/useAsync";
import { actionShortcutAllowed, FALLBACK_RULES, isReservedCloseEvent, matchesKey, ruleMatches, runHandlers, setTerminalRules, useCommand, whenHolds, type WhenContext } from "./shortcuts";
import { useTaskRunNotifications } from "./taskNotifications";
import { actionIdFromCommand } from "../lib/actionCommand";
import { layoutForWidth, useLayoutWidth } from "../lib/useLayout";
import { goToHash, navigate, parseRoute, routeHref, useRoute, type Route } from "../state/route";
import { DRAFT_LAYOUT, useUi, type ContextTab, type ThemeChoice } from "../state/ui";
import { useVisibleProjects, useWorkspace } from "../state/workspace";
import { TitleBar } from "./TitleBar";
import { useReadingNav } from "./readingNav";
import { toggleSidebarDrawer, useSidebarDrawer } from "./sidebarDrawer";
import { useEscapeClose } from "../ui/useEscapeClose";

const HIDDEN_POLL_EVERY = 3;
const POLL_MS = 4000;

// One load at a time: a remount (React's development double mount included) or a
// slow load meeting the next tick joins the load already running.
let loading: Promise<void> | null = null;
const loadAll = () =>
  (loading ??= useWorkspace.getState().refreshAll().finally(() => {
    loading = null;
  }));
let loadingEngines: Promise<void> | null = null;
const loadEngines = () =>
  (loadingEngines ??= useWorkspace.getState().refreshEngines().finally(() => {
    loadingEngines = null;
  }));

type PageRoute = Exclude<Route, { name: "settings" }>;

function Home({ needsProject }: { needsProject: boolean }) {
  // The welcome steps take the whole page while they are open; the empty home is what they leave.
  const welcome = useUi((state) => state.welcomeStep !== null);
  return (
    <div className="home-stack">
      <WelcomeHost needsProject={needsProject} />
      {welcome ? null : needsProject ? <NoProjects /> : <DraftView key="draft" projectId={null} />}
    </div>
  );
}

function RouteView({ route, needsProject }: { route: PageRoute; needsProject: boolean }) {
  switch (route.name) {
    case "home":
      return <Home needsProject={needsProject} />;
    case "pulls":
      return <PullsPage />;
    case "usage":
      return <UsagePage />;
    case "tasks":
      return <ScheduledTasksPage />;
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

function jumpRows() {
  const { threads } = useWorkspace.getState();
  // The sidebar's own order, when it is on screen: jumps must match the numbers it shows.
  const drawn = useDrawnOrder.getState().ids;
  if (drawn) {
    return drawn
      .map((id) => threads[id])
      .filter((thread): thread is Thread => thread !== undefined && !thread.lifecycle?.settled_at);
  }
  return threadsFlat(arrangeThreads(Object.values(threads), Date.now())).filter(
    (thread) => !thread.lifecycle?.settled_at,
  );
}

function stepThread(route: Route, step: number): boolean {
  const rows = jumpRows();
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
    const row = jumpRows()[Number(jump[1]) - 1];
    if (row) navigate({ name: "thread", id: row.id });
    return row !== undefined;
  }
  switch (command) {
    case "sidebar.toggle":
      if (layoutForWidth(window.innerWidth) === "small") toggleSidebarDrawer();
      else if (ui.workspaceLayout === "reading") useReadingNav.getState().toggle();
      else ui.toggleSidebar();
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
    dialogOpen: document.querySelector("dialog[open]") !== null,
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
  waiting: "needs you",
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
        if (inAppNotifications) pushToast(`${thread.title} ${notice}`, now === "waiting" ? "needs" : now === "done" ? "done" : "failed");
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
  useCommand("keybindings.reload", () => void reload());
  const rules = keymap.data?.rules ?? FALLBACK_RULES;
  useEffect(() => {
    setTerminalRules(rules, () => keyContext(parseRoute(window.location.hash)));
    return () => setTerminalRules([]);
  }, [rules]);
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
      const actionAllowed = () => actionShortcutAllowed(event, keyContext(route));
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (actionAllowed()) {
          for (const rule of [...rules].reverse()) {
            if (!rule.remove && actionIdFromCommand(rule.command) !== null && matchesKey(rule.key, event)
              && whenHolds(rule.when, keyContext(route)) && (runHandlers(rule.command) || runHandlers("projectActions.pending", rule.command))) {
              event.preventDefault(); return;
            }
          }
        }
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
      const modified = event.metaKey || event.ctrlKey || event.altKey || /^F\d+$/.test(event.key);
      if (modified || actionAllowed()) {
        const context = keyContext(route);
        // The last rule wins, so the file overrides a default.
        for (const rule of [...rules].reverse()) {
          const action = actionIdFromCommand(rule.command) !== null;
          if ((!modified && !action) || (action && !actionAllowed())) continue;
          if (rule.remove || !ruleMatches(rule.key, event, inDesktopApp()) || !whenHolds(rule.when, context)) continue;
          if (runHandlers(rule.command) || (action && runHandlers("projectActions.pending", rule.command)) || runShellCommand(rule.command, route)) {
            event.preventDefault();
            return;
          }
        }
      }
      // Nothing took it, but the desktop window still must not close on it.
      if (inDesktopApp() && isReservedCloseEvent(event)) {
        event.preventDefault();
        return;
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

/**
 * Keeps the toast stack clear of the composer: `--toast-lift` is how far its top edge stands
 * above the window's bottom, so the stack sits just above it. Only the composer is watched,
 * so a streaming reply costs nothing here.
 */
function useToastClearance(key: string) {
  useEffect(() => {
    const root = document.documentElement;
    let composer: Element | null = null;
    let frame = 0;
    const apply = () => {
      const rect = composer?.getBoundingClientRect();
      const lift = rect && rect.height > 0 ? Math.max(0, window.innerHeight - rect.top + 8) : 0;
      root.style.setProperty("--toast-lift", `${lift}px`);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    // A screen's composer mounts a little after the route changes; look for it for a second.
    let tries = 0;
    const find = () => {
      composer = document.querySelector(".composer");
      if (composer) observer?.observe(composer);
      apply();
      if (!composer && ++tries < 60) frame = requestAnimationFrame(find);
    };
    find();
    // The composer glides to the bottom when a first message is sent; its size need not change.
    window.addEventListener("resize", apply);
    window.addEventListener("transitionend", apply, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", apply);
      window.removeEventListener("transitionend", apply, true);
      root.style.removeProperty("--toast-lift");
    };
  }, [key]);
}

/** Moves focus into the new screen, so keyboard and screen reader users follow it. */
function useRouteFocus(routeKey: string, routeName: string, ready: boolean, main: React.RefObject<HTMLElement | null>) {
  const first = useRef(true);
  const previous = useRef({ key: routeKey, name: routeName });
  // What had focus, and which page was showing, when settings opened.
  const opener = useRef<{ element: Element | null; key: string } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const root = main.current;
    if (!root) return;
    const before = previous.current;
    previous.current = { key: routeKey, name: routeName };
    if (routeName === "settings" && before.name !== "settings") {
      const active = document.activeElement;
      opener.current = { element: active && active !== document.body ? active : null, key: before.key };
    } else if (routeName !== "settings" && before.name === "settings") {
      // Closing settings returns to what opened it, if it is still there and the page behind is showing.
      const back = opener.current;
      opener.current = null;
      if (back?.element instanceof HTMLElement && back.element.isConnected && back.key === routeKey && !back.element.closest("[hidden]")) {
        back.element.focus({ preventScroll: true });
        return;
      }
    }
    // A page kept mounted behind settings is hidden, so it never takes the focus.
    const visible = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].find((element) => !element.closest("[hidden]")) ?? null;
    const target = visible("[data-autofocus]") ?? (first.current ? null : visible("[data-page-title]"));
    first.current = false;
    (target ?? root).focus({ preventScroll: true });
    root.scrollTop = 0;
  }, [routeKey, routeName, ready, main]);
}

/** Links and menu items from the desktop shell, which behave like keys pressed here. */
export function onShellEvent(event: ShellEvent) {
  switch (event.type) {
    case "navigate":
      goToHash(event.href.slice(1));
      return;
    case "command":
      if (!runHandlers(event.command)) runShellCommand(event.command, parseRoute(window.location.hash));
      return;
    case "changed":
      shellChanged();
      return;
    case "failed":
      useUi.getState().pushToast(event.message);
      return;
    case "show_preview":
      goToHash(`/threads/${event.thread_id}`);
      useUi.getState().showInBrowser({ tabId: event.tab_id });
  }
}

export function Shell() {
  const route = useRoute();
  const layout = useLayoutWidth();
  const projects = useVisibleProjects();
  const collapsed = useUi((state) => state.sidebarCollapsed);
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
  useTaskRunNotifications();
  usePanelMotionRoot(routeKey);
  useRouteFocus(routeKey, route.name, threadReady, main);
  useToastClearance(`${routeKey}:${threadReady}`);

  useEffect(() => {
    void loadAll();
    void loadEngines();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      // A hidden window keeps up while work runs, or its alerts would never fire, and
      // looks in now and then so it hears of work started elsewhere.
      const running = Object.values(useWorkspace.getState().threads).some((thread) => thread.active_run);
      if (!document.hidden || running || ticks % HIDDEN_POLL_EVERY === 0) void loadAll();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const needsProject = projects !== null && projects.length === 0;
  const overlay = route.name === "settings";
  const underneath = overlay ? behindSettings.current : route;
  if (!overlay) behindSettings.current = route;
  const onHome = underneath.name === "home" && !needsProject;
  const reading = useUi((state) => state.workspaceLayout === "reading");
  const readingNav = useReadingNav((state) => state.open);
  // Small windows (600 to 899 px) fold the sidebar into a drawer over the thread.
  const small = layout === "small";
  const drawerOpen = useSidebarDrawer((state) => state.open);
  const closeDrawer = useSidebarDrawer((state) => state.close);
  const showNav = layout === "phone" ? onHome && route.name !== "settings" : small ? drawerOpen : reading ? readingNav : !collapsed;
  // Choosing something closes it, and a window that grows past small leaves nothing open behind.
  useEffect(() => {
    closeDrawer();
  }, [routeKey, small, closeDrawer]);
  useEscapeClose(small && drawerOpen, closeDrawer, () => document.querySelector<HTMLElement>("[data-sidebar-toggle]"));
  const dismissDrawer = () => {
    closeDrawer();
    document.querySelector<HTMLElement>("[data-sidebar-toggle]")?.focus();
  };

  return (
    <div
      className="shell"
      data-nav={showNav && !small ? "shown" : "hidden"}
      data-drawer={small && drawerOpen ? "open" : undefined}
      data-layout={layout}
      data-reading-nav={readingNav ? "open" : undefined}
      data-page={underneath.name}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
    >
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        main.current?.focus();
      }}>
        Skip to content
      </a>
      <TitleBar route={route} layout={layout} />
      {small && drawerOpen ? <div className="drawer-scrim" aria-hidden onClick={dismissDrawer} /> : null}
      {showNav ? (
        small ? (
          // Choosing a thread or page closes the drawer, even one already open.
          <div className="sidebar-drawer" onClick={(event) => (event.target as Element).closest("a[href]") && dismissDrawer()}>
            <Sidebar route={route} />
          </div>
        ) : (
          <Sidebar route={route} />
        )
      ) : null}
      <BackgroundAnnouncer />
      <QuitConfirmation />
      <PreviewFloat threadId={route.name === "thread" ? route.id : null} />
      <Toasts
        lead={
          <>
            <FoldersNotice />
            <GitHubStarPrompt />
          </>
        }
      />
      <CloneJobs />
      {palette ? <CommandPalette start={palette} onClose={() => setPalette(null)} /> : null}
      {layout === "phone" && onHome && !overlay ? (
        <main id="main" ref={main} tabIndex={-1} hidden />
      ) : (
        <main id="main" ref={main} tabIndex={-1} className="main">
          {route.name === "settings" ? <SettingsPage section={route.section} onClose={() => navigate(underneath)} /> : null}
          {/* The page behind settings stays mounted, so a terminal, preview or scroll position survives. */}
          <div className="main-view" hidden={route.name === "settings"}>
            <RouteView route={underneath} needsProject={needsProject} />
          </div>
        </main>
      )}
    </div>
  );
}
