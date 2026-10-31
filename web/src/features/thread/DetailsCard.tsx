import {
  Activity,
  Copy,
  FileDiff,
  Monitor,
  SquareTerminal,
  EllipsisVertical,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { EngineStatus, Thread } from "../../api/types";
import { elapsed } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { useNow } from "../../lib/useNow";
import { navigate } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { EngineGlyph } from "../../ui/badges";
import { Button, IconButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { BranchRow } from "./GitControl";
import { OpenInEditor } from "./OpenInEditor";
import { runningTools } from "./timeline";

function ThreadMenu({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dropThread = useWorkspace((state) => state.dropThread);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && menu.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={menu}>
      <IconButton label="Thread actions" aria-expanded={open} onClick={() => setOpen(!open)}>
        <EllipsisVertical size={14} aria-hidden />
      </IconButton>
      {open ? (
        <div className="menu">
          <Button
            tone="quiet"
            small
            icon={<Trash2 size={16} aria-hidden />}
            disabled={thread.active_run !== null}
            onClick={() => {
              setOpen(false);
              setConfirming(true);
            }}
          >
            Delete thread
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title="Delete thread?"
          confirmLabel="Delete thread"
          tone="danger"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await api.deleteThread(thread.id);
            dropThread(thread);
            navigate({ name: "home" });
          }}
        >
          <p>
            “{thread.title}” and its log are removed from Orbyn. Files on disk and any worktree stay
            where they are.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function ChangesRow({ threadId }: { threadId: string }) {
  const version = useThreadLogs((state) => state.diffVersion[threadId] ?? 0);
  const diff = useAsync(`details-diff:${threadId}`, (signal) => api.diff(threadId, signal));
  const { reload } = diff;
  const togglePanel = useUi((state) => state.togglePanel);
  const showing = useUi((state) => state.panelOpen === true && state.panelTab === "diff");

  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

  const files = diff.data ?? [];
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <button
      type="button"
      className="detail-row"
      onClick={() => {
        if (!showing) togglePanel("diff");
      }}
    >
      <FileDiff size={16} aria-hidden />
      <span>Changes</span>
      {diff.status === "error" ? (
        <span className="detail-meta">Unavailable</span>
      ) : diff.data ? (
        <span className="detail-meta">
          <span className="diff-add">+{added}</span> <span>-{removed}</span>
        </span>
      ) : null}
    </button>
  );
}

function RunningList({ threadId, active }: { threadId: string; active: boolean }) {
  const log = useThreadLogs((state) => state.logs[threadId]);
  const tools = useMemo(() => (active ? runningTools(log?.items ?? []) : []), [log, active]);
  const now = useNow(tools.length > 0);
  if (tools.length === 0) return null;
  return (
    <ul className="detail-running">
      {[...tools].reverse().map((tool) => (
        <li key={tool.key}>
          <EngineGlyph name={tool.name} />
          <span>{tool.name}</span>
          <span className="detail-age">{elapsed(tool.ts, now)}</span>
        </li>
      ))}
    </ul>
  );
}

export function DetailsCard({
  thread,
  engine,
  compact,
  onClose,
}: {
  thread: Thread;
  engine: EngineStatus | null;
  /** On one-surface layouts the card also carries the panel shortcuts. */
  compact: boolean;
  onClose(): void;
}) {
  const remote = useRemoteLabel();
  const log = useThreadLogs((state) => state.logs[thread.id]);
  const runningCount = useMemo(
    () => (thread.active_run ? runningTools(log?.items ?? []).length : 0),
    [log, thread.active_run],
  );
  const togglePanel = useUi((state) => state.togglePanel);
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.targets.find((t) => t.project_id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const pushToast = useUi((state) => state.pushToast);
  const copyPath = () => {
    navigator.clipboard?.writeText(thread.cwd).then(
      () => pushToast("Folder path copied"),
      () => pushToast("Couldn't copy the path"),
    );
  };

  return (
    <aside className="details" aria-label="Thread details">
      <div className="details-section">
        <div className="detail-row detail-row-static">
          <Monitor size={16} aria-hidden />
          <span className="detail-dim">{remote}</span>
          <IconButton label={`Copy folder path ${thread.cwd}`} onClick={copyPath}>
            <Copy size={14} aria-hidden />
          </IconButton>
          <ThreadMenu thread={thread} />
          {compact ? (
            <IconButton label="Close details" onClick={onClose}>
              <X size={14} aria-hidden />
            </IconButton>
          ) : null}
        </div>
        <div className="detail-row detail-row-static">
          <EngineGlyph name={engine?.name ?? thread.engine} />
          <span>{engine?.name ?? thread.engine}</span>
          {engine && !engine.capabilities.managed ? <span className="detail-dim">Unmanaged</span> : null}
        </div>
      </div>
      <div className="details-section">
        {branch ? <BranchRow thread={thread} branch={branch} /> : null}
        <ChangesRow threadId={thread.id} />
        <OpenInEditor threadId={thread.id} />
        {compact ? (
          <>
            <button type="button" className="detail-row" onClick={() => togglePanel("activity")}>
              <Activity size={16} aria-hidden />
              <span>Activity</span>
            </button>
            <button type="button" className="detail-row" onClick={() => togglePanel("terminal")}>
              <SquareTerminal size={16} aria-hidden />
              <span>Terminal</span>
            </button>
          </>
        ) : null}
      </div>
      {runningCount > 0 ? (
        <div className="details-section">
          <div className="details-head">
            <span>This run · {runningCount} running</span>
          </div>
          <RunningList threadId={thread.id} active={thread.active_run !== null} />
        </div>
      ) : null}
    </aside>
  );
}

function useRemoteLabel(): string {
  const info = useAsync("details-info", (signal) => api.info(signal));
  return info.data?.remote ? "Remote service" : "This computer";
}
