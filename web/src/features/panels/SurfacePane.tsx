import {
  Activity,
  AppWindow,
  FileDiff,
  Files,
  GitPullRequest,
  Maximize2,
  MessagesSquare,
  MoreHorizontal,
  PanelBottom,
  PanelRight,
  SquareTerminal,
  ArrowLeft,
  CloudOff,
  X,
  type LucideIcon,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { useAsync } from "../../lib/useAsync";
import { useThreadLogs } from "../thread/threadLogs";
import { useUi, type ContextTab, type RightTab } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { ActivityPanel } from "./ActivityPanel";
import { BrowserPanel } from "./BrowserPanel";
import { DiffPanel } from "./DiffPanel";
import { FilesPanel } from "./FilesPanel";
import { LinkedPulls } from "./LinkedPulls";
import { openSideChat } from "./sideChat";
import { SideChatPane } from "./SideChatPane";
import { fitTabs, RIGHT_TABS } from "./tabs";
import { useConnectionKind } from "../../state/connection";
import { Menu, type MenuItem } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";

interface LauncherAction {
  id: ContextTab | "new-side";
  label: string;
  icon: LucideIcon;
  shortcut: string;
  available: boolean;
}

function Launcher({ thread, back }: { thread: Thread; back: RightTab | null }) {
  const toggle = useUi((state) => state.togglePanel);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const activity = useThreadLogs((state) => (state.logs[thread.id]?.timeline.length ?? 0) > 0);
  const version = useThreadLogs((state) => state.diffVersion[thread.id] ?? 0);
  const diff = useAsync(`launcher-diff:${thread.id}`, (signal) => api.diff(thread.id, signal));
  const { reload } = diff;
  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

  const root = useRef<HTMLDivElement>(null);
  // Reached from a tab: take focus so Escape can return to it.
  useEffect(() => {
    if (back) root.current?.focus();
  }, [back]);

  const actions: LauncherAction[] = [
    { id: "browser", label: "Browser", icon: AppWindow, shortcut: "B", available: true },
    { id: "terminal", label: "Terminal", icon: SquareTerminal, shortcut: "T", available: true },
    { id: "diff", label: "Diff", icon: FileDiff, shortcut: "D", available: (diff.data?.length ?? 0) > 0 },
    { id: "files", label: "Files", icon: Files, shortcut: "F", available: true },
    { id: "activity", label: "Activity", icon: Activity, shortcut: "A", available: activity },
    { id: "pulls", label: "Pull requests", icon: GitPullRequest, shortcut: "P", available: true },
    { id: "new-side", label: "Side chat", icon: MessagesSquare, shortcut: "S", available: true },
  ];

  const open = (action: LauncherAction) => {
    if (action.id === "terminal" && terminalOpen) return;
    if (action.id === "new-side") void openSideChat(thread, null);
    else toggle(action.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && back) {
      event.preventDefault();
      toggle(back);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const action = actions.find((entry) => entry.shortcut === event.key.toUpperCase());
    if (action?.available) {
      event.preventDefault();
      open(action);
    }
  };

  return (
    <div ref={root} className="launcher" tabIndex={0} aria-label="Open a surface" onKeyDown={onKeyDown}>
      <div className="launcher-inner">
        <h2>Open a surface</h2>
        <ul>
          {actions.map((action) => (
            <li key={action.id}>
              <button type="button" disabled={!action.available} onClick={() => open(action)}>
                <action.icon size={16} aria-hidden />
                <span>{action.label}</span>
                <kbd>{action.shortcut}</kbd>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const MIN_PANE = 360;
/** The More button: a 24px icon button. */
const MORE_WIDTH = 24;
const MORE_MENU_WIDTH = 210;
/** Tabs that need this device's network. Diff, Files, Activity and the terminal keep working offline. */
const NEEDS_NETWORK: readonly RightTab[] = ["browser", "side", "pulls"];
const MIN_MAIN = 420;

/** Saves this thread's pane width when the drag ends. The width shows beside the edge while it moves. */
export function PaneResizer() {
  const setWidth = useUi((state) => state.setPanelWidth);
  const [dragging, setDragging] = useState<number | null>(null);
  const clamp = (right: number, x: number) =>
    Math.max(MIN_PANE, Math.min(right - MIN_MAIN, Math.round(right - x)));
  return (
    <>
      <div
        className="pane-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        title="Drag to resize"
        onDoubleClick={() => setWidth(null)}
        onPointerDown={(event) => {
          const pane = event.currentTarget.parentElement;
          if (!pane) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const right = pane.getBoundingClientRect().right;
          const handle = event.currentTarget;
          pane.dataset.resizing = "";
          setDragging(Math.round(pane.getBoundingClientRect().width));
          const move = (moved: PointerEvent) => {
            const next = clamp(right, moved.clientX);
            pane.style.width = `${next}px`;
            setDragging(next);
          };
          const stop = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("lostpointercapture", stop);
            delete pane.dataset.resizing;
            setDragging(null);
            setWidth(Math.round(pane.getBoundingClientRect().width));
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("lostpointercapture", stop);
        }}
      />
      {dragging === null ? null : (
        <span className="pane-width" role="status">
          {dragging} px
        </span>
      )}
    </>
  );
}

export function SurfacePane({
  thread,
  overlay,
  closing,
  moves,
  maximized,
  onToggleMaximize,
  onReturn,
}: {
  thread: Thread;
  /** True when the pane replaces the thread instead of sitting beside it. */
  overlay: boolean;
  closing: boolean;
  /** False while the pane is part of the page as it first appeared. */
  moves: boolean;
  maximized: boolean;
  onToggleMaximize(): void;
  onReturn(): void;
}) {
  const tab = useUi((state) => state.panelTab);
  const toggle = useUi((state) => state.togglePanel);
  const showLauncher = useUi((state) => state.showLauncher);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const width = useUi((state) => state.panelWidth);

  // The tab the list was opened from, for Escape to return to.
  const lastTab = useRef<RightTab | null>(null);
  if (tab !== null) lastTab.current = tab;
  const list = useRef<HTMLDivElement>(null);
  const kind = useConnectionKind();
  // When the row is narrow, the tabs that don't fit fold into More; the open tab always stays.
  const widths = useRef(new Map<RightTab, number>());
  const [shown, setShown] = useState<readonly RightTab[]>(() => RIGHT_TABS.map(({ id }) => id));
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const folded = shown.length < RIGHT_TABS.length;
  const latest = useRef({ tab, folded });
  latest.current = { tab, folded };
  const refit = useCallback(() => {
    const row = list.current;
    if (!row) return;
    for (const element of row.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const id = element.id.replace("context-tab-", "") as RightTab;
      if (element.offsetWidth > 0) widths.current.set(id, element.offsetWidth);
    }
    // The row is narrower by the More button while it shows.
    const room = row.clientWidth + (latest.current.folded ? MORE_WIDTH : 0);
    const next = fitTabs(RIGHT_TABS.map(({ id }) => id), widths.current, room, MORE_WIDTH, latest.current.tab);
    setShown((current) => (current.length === next.length && current.every((id, i) => id === next[i]) ? current : next));
  }, []);
  useLayoutEffect(() => {
    const row = list.current;
    if (!row) return;
    refit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
    observer?.observe(row);
    return () => observer?.disconnect();
  }, [refit]);
  useLayoutEffect(refit, [tab, refit]);
  const hiddenTabs: MenuItem[] = RIGHT_TABS.filter(({ id }) => !shown.includes(id)).map(({ id, text, icon: Icon }) => ({
    label: text,
    icon: <Icon size={14} aria-hidden />,
    onSelect: () => toggle(id),
  }));
  // One Tab stop: the chosen tab, or the first while none is chosen.
  const stop = tab ?? RIGHT_TABS[0]?.id;
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = RIGHT_TABS.findIndex(({ id }) => id === stop);
    const next =
      event.key === "ArrowRight" ? (at + 1) % RIGHT_TABS.length
      : event.key === "ArrowLeft" ? (at - 1 + RIGHT_TABS.length) % RIGHT_TABS.length
      : event.key === "Home" ? 0
      : event.key === "End" ? RIGHT_TABS.length - 1
      : -1;
    const target = RIGHT_TABS[next];
    if (!target) return;
    event.preventDefault();
    toggle(target.id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`#context-tab-${target.id}`)?.focus());
  };

  return (
    <aside
      className="context"
      aria-label="Thread context"
      data-closing={closing || undefined}
      data-moves={moves || undefined}
      data-maximized={maximized || undefined}
      style={width !== null && !overlay && !maximized ? { width } : undefined}
    >
      {overlay || maximized ? null : <PaneResizer />}
      <header className="context-head">
        {overlay ? (
          <Button small tone="quiet" icon={<ArrowLeft size={16} aria-hidden />} onClick={onReturn}>
            Back to thread
          </Button>
        ) : null}
        <div ref={list} className="tabs" role="tablist" aria-label="Context" onKeyDown={onTabKey}>
          {RIGHT_TABS.filter(({ id }) => shown.includes(id)).map(({ id, label, text }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="ptab"
              id={`context-tab-${id}`}
              data-selected={tab === id || undefined}
              aria-selected={tab === id}
              tabIndex={stop === id ? 0 : -1}
              aria-controls={tab === id ? `context-${id}` : undefined}
              aria-label={text === label ? undefined : label}
              data-offline={kind === "offline" && NEEDS_NETWORK.includes(id) ? "" : undefined}
              {...(tab === id ? { "aria-description": "Opens all surfaces", title: "Click again for all surfaces" } : {})}
              onClick={() => {
                if (tab !== id) toggle(id);
                else showLauncher();
              }}
            >
              {text}
            </button>
          ))}
        </div>
        <div className="layout-toggles end">
          {folded ? (
            <IconButton
              className="tabs-more"
              label="More tabs"
              pressed={moreMenu !== null}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMoreMenu(moreMenu ? null : { x: rect.right - MORE_MENU_WIDTH, y: rect.bottom + 4 });
              }}
            >
              <MoreHorizontal size={16} aria-hidden />
            </IconButton>
          ) : null}
          {overlay ? null : (
            <IconButton label={maximized ? "Restore side panel" : "Maximize pane"} onClick={onToggleMaximize}>
              {maximized ? <PanelRight size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
            </IconButton>
          )}
          <IconButton label="Terminal" pressed={terminalOpen} onClick={() => toggle("terminal")}>
            <PanelBottom size={16} aria-hidden />
          </IconButton>
          <IconButton label="Close side panel" onClick={onReturn}>
            <X size={16} aria-hidden />
          </IconButton>
        </div>
      </header>
      <Presence>
        {moreMenu ? (
          <Menu
            x={moreMenu.x}
            y={moreMenu.y}
            label="Hidden tabs"
            heading="Hidden tabs"
            items={hiddenTabs}
            onClose={() => setMoreMenu(null)}
          />
        ) : null}
      </Presence>
      <div className="context-body" data-connection={kind ?? undefined}>
        {kind === "offline" && tab !== null && NEEDS_NETWORK.includes(tab) ? (
          <p className="conn-banner conn-panel-banner" role="status">
            <CloudOff size={13} aria-hidden />
            <span>You’re offline.</span>
          </p>
        ) : null}
        {kind === "service-down" && tab !== null && tab !== "browser" ? (
          <div className="conn-wait">
            <b>Waiting for the Orbyn service</b>
            {tab === "diff" ? <span>The diff comes back when the service does.</span> : null}
          </div>
        ) : tab === null ? (
          <Launcher thread={thread} back={lastTab.current} />
        ) : (
          <div id={`context-${tab}`} role="tabpanel" aria-labelledby={`context-tab-${tab}`} className="tabpanel">
            {tab === "browser" ? (
              <BrowserPanel threadId={thread.id} />
            ) : tab === "diff" ? (
              <DiffPanel threadId={thread.id} />
            ) : tab === "files" ? (
              <FilesPanel threadId={thread.id} />
            ) : tab === "activity" ? (
              <ActivityPanel key={thread.id} threadId={thread.id} />
            ) : tab === "side" ? (
              <SideChatPane parent={thread} />
            ) : (
              <LinkedPulls thread={thread} />
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
