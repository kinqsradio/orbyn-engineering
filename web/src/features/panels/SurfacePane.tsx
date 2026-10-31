import {
  Activity,
  FileDiff,
  Maximize2,
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
import { DiffPanel } from "./DiffPanel";
import { RIGHT_TABS } from "./tabs";

interface LauncherAction {
  id: ContextTab;
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
    { id: "terminal", label: "Terminal", icon: SquareTerminal, shortcut: "T", available: true },
    { id: "diff", label: "Diff", icon: FileDiff, shortcut: "D", available: (diff.data?.length ?? 0) > 0 },
    { id: "activity", label: "Activity", icon: Activity, shortcut: "A", available: activity },
  ];

  const open = (action: LauncherAction) => {
    if (action.id === "terminal" && terminalOpen) return;
    toggle(action.id);
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

  return (
    <aside
      className="context"
      aria-label="Thread context"
      data-closing={closing || undefined}
      data-maximized={maximized || undefined}
    >
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
              <button type="button" aria-label={`Close ${label}`} className="surface-close" onClick={() => closeSurface(id)}>
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
            {tab === "diff" ? <DiffPanel threadId={thread.id} /> : <ActivityPanel threadId={thread.id} />}
          </div>
        )}
      </div>
    </aside>
  );
}
