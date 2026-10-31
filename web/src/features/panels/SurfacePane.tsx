import {
  Activity,
  AppWindow,
  FileDiff,
  Files,
  GitPullRequest,
  Maximize2,
  MessagesSquare,
  Minimize2,
  PanelBottom,
  PanelRight,
  Plus,
  SquareTerminal,
  ArrowLeft,
  X,
  type LucideIcon,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect } from "react";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { useAsync } from "../../lib/useAsync";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi, type ContextTab } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { ActivityPanel } from "./ActivityPanel";
import { BrowserPanel } from "./BrowserPanel";
import { DiffPanel } from "./DiffPanel";
import { FilesPanel } from "./FilesPanel";
import { LinkedPulls } from "./LinkedPulls";
import { closeSideChat, openSideChat } from "./sideChat";
import { SideChatPane } from "./SideChatPane";
import { RIGHT_TABS } from "./tabs";

interface LauncherAction {
  id: ContextTab | "new-side";
  label: string;
  icon: LucideIcon;
  shortcut: string;
  available: boolean;
}

function Launcher({ thread }: { thread: Thread }) {
  const toggle = useUi((state) => state.togglePanel);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const activity = useThreadLogs((state) => (state.logs[thread.id]?.timeline.length ?? 0) > 0);
  const version = useThreadLogs((state) => state.diffVersion[thread.id] ?? 0);
  const diff = useAsync(`launcher-diff:${thread.id}`, (signal) => api.diff(thread.id, signal));
  const { reload } = diff;
  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

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
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const action = actions.find((entry) => entry.shortcut === event.key.toUpperCase());
    if (action?.available) {
      event.preventDefault();
      open(action);
    }
  };

  return (
    <div className="launcher" tabIndex={0} aria-label="Open a surface" onKeyDown={onKeyDown}>
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
const MIN_MAIN = 420;

/** Saves this thread's pane width when the drag ends. */
export function PaneResizer() {
  const setWidth = useUi((state) => state.setPanelWidth);
  const clamp = (right: number, x: number) =>
    Math.max(MIN_PANE, Math.min(right - MIN_MAIN, Math.round(right - x)));
  return (
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
        const move = (moved: PointerEvent) => {
          pane.style.width = `${clamp(right, moved.clientX)}px`;
        };
        const stop = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("lostpointercapture", stop);
          setWidth(Math.round(pane.getBoundingClientRect().width));
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("lostpointercapture", stop);
      }}
    />
  );
}

export function SurfacePane({
  thread,
  overlay,
  closing,
  maximized,
  onToggleMaximize,
  onReturn,
}: {
  thread: Thread;
  /** True when the pane replaces the thread instead of sitting beside it. */
  overlay: boolean;
  closing: boolean;
  maximized: boolean;
  onToggleMaximize(): void;
  onReturn(): void;
}) {
  const tab = useUi((state) => state.panelTab);
  const surfaces = useUi((state) => state.openSurfaces);
  const toggle = useUi((state) => state.togglePanel);
  const showLauncher = useUi((state) => state.showLauncher);
  const closeSurface = useUi((state) => state.closeSurface);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const width = useUi((state) => state.panelWidth);

  return (
    <aside
      className="context"
      aria-label="Thread context"
      data-closing={closing || undefined}
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
        <IconButton label="New surface" onClick={showLauncher} pressed={tab === null}>
          <Plus size={16} aria-hidden />
        </IconButton>
        <div className="tabs" role="tablist" aria-label="Context">
          {RIGHT_TABS.filter(({ id }) => surfaces.includes(id)).map(({ id, label }) => (
            <span key={id} className="surface-tab" data-selected={tab === id || undefined}>
              <button
                type="button"
                role="tab"
                id={`context-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`context-${id}`}
                onClick={() => {
                  if (tab !== id) toggle(id);
                }}
              >
                {label}
              </button>
              <button type="button" aria-label={`Close ${label}`} className="surface-close" onClick={() => (id === "side" ? closeSideChat() : closeSurface(id))}>
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
        {overlay ? null : (
          <div className="layout-toggles">
            <IconButton label={maximized ? "Restore pane" : "Maximize pane"} onClick={onToggleMaximize}>
              {maximized ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
            </IconButton>
            <IconButton label="Terminal" pressed={terminalOpen} onClick={() => toggle("terminal")}>
              <PanelBottom size={16} aria-hidden />
            </IconButton>
            <IconButton label="Close surfaces" pressed onClick={onReturn}>
              <PanelRight size={16} aria-hidden />
            </IconButton>
          </div>
        )}
      </header>
      <div className="context-body">
        {tab === null ? (
          <Launcher thread={thread} />
        ) : (
          <div id={`context-${tab}`} role="tabpanel" aria-labelledby={`context-tab-${tab}`} className="tabpanel">
            {tab === "browser" ? (
              <BrowserPanel threadId={thread.id} />
            ) : tab === "diff" ? (
              <DiffPanel threadId={thread.id} />
            ) : tab === "files" ? (
              <FilesPanel threadId={thread.id} />
            ) : tab === "activity" ? (
              <ActivityPanel threadId={thread.id} />
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
