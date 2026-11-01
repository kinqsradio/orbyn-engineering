import {
  Activity,
  Copy,
  FileDiff,
  Gauge,
  GitPullRequest,
  MessagesSquare,
  Monitor,
  Play,
  Server,
  SquareTerminal,
  EllipsisVertical,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, request } from "../../api/client";
import type { EngineLimits, EngineStatus, ProjectFileView, Thread } from "../../api/types";
import { compactAge, elapsed } from "../../lib/format";
import { showSideChat, sideChatsOf } from "../panels/sideChat";
import { toFailure, useAsync } from "../../lib/useAsync";
import { usageShare } from "./ComposerExtras";
import { useNow } from "../../lib/useNow";
import { navigate } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { EngineGlyph } from "../../ui/badges";
import { Menu, type MenuItem } from "../../ui/Menu";
import { pullsApi } from "../pulls/pullsApi";
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

export const DETAIL_ROWS: { id: string; label: string }[] = [
  { id: "branch", label: "Branch" },
  { id: "changes", label: "Changes" },
  { id: "pulls", label: "Pull requests" },
  { id: "servers", label: "Local servers" },
  { id: "limits", label: "Limits" },
  { id: "usage", label: "Usage" },
  { id: "scripts", label: "Scripts" },
  { id: "editor", label: "Open in editor" },
];

/** The rows as a checklist, for the card's menu and for Settings. */
export function detailsMenuItems(): MenuItem[] {
  const { detailsHidden, setPrefs } = useUi.getState();
  return [
    ...DETAIL_ROWS.map((row) => ({
      label: row.label,
      selected: !detailsHidden.includes(row.id),
      onSelect: () =>
        setPrefs({
          detailsHidden: detailsHidden.includes(row.id)
            ? detailsHidden.filter((id) => id !== row.id)
            : [...detailsHidden, row.id],
        }),
    })),
    { label: "Reset", separatorBefore: true, onSelect: () => setPrefs({ detailsHidden: ["usage"] }) },
  ];
}

function PullRows({ threadId }: { threadId: string }) {
  const pulls = useAsync(`details-pulls:${threadId}`, (signal) => pullsApi.linked(threadId, signal));
  const togglePanel = useUi((state) => state.togglePanel);
  const showing = useUi((state) => state.panelOpen === true && state.panelTab === "pulls");
  const linked = Array.isArray(pulls.data) ? pulls.data : [];
  return linked.slice(0, MAX_PULL_ROWS).map((pull) => (
    <button key={pull.number} type="button" className="detail-row" onClick={() => (showing ? undefined : togglePanel("pulls"))}>
      <GitPullRequest size={16} aria-hidden />
      <span>{pull.title}</span>
      <span className="detail-meta">#{pull.number}</span>
    </button>
  ));
}

function ServersRow({ threadId }: { threadId: string }) {
  const servers = useAsync(`details-servers:${threadId}`, (signal) =>
    request<unknown[]>("GET", `/api/threads/${encodeURIComponent(threadId)}/servers`, undefined, signal),
  );
  const togglePanel = useUi((state) => state.togglePanel);
  const count = servers.data?.length ?? 0;
  if (count === 0) return null;
  return (
    <button type="button" className="detail-row" onClick={() => togglePanel("browser")}>
      <Server size={16} aria-hidden />
      <span>Local servers</span>
      <span className="detail-meta">{count}</span>
    </button>
  );
}

function UsageRow({ threadId }: { threadId: string }) {
  const usage = useThreadLogs((state) => state.logs[threadId]?.usage);
  const share = usageShare(usage);
  if (!share) return null;
  return (
    <div className="detail-row detail-row-static">
      <Gauge size={16} aria-hidden />
      <span>Usage</span>
      <span className="detail-meta">
        {share.used.toLocaleString()} of {share.window.toLocaleString()}
      </span>
    </div>
  );
}

function ScriptRows({ threadId }: { threadId: string }) {
  const base = `/api/threads/${encodeURIComponent(threadId)}`;
  const scripts = useAsync(`details-scripts:${threadId}`, (signal) =>
    request<ProjectFileView>("GET", `${base}/scripts`, undefined, signal),
  );
  const pushToast = useUi((state) => state.pushToast);
  const list = scripts.data?.scripts ?? [];
  const run = (name: string) => {
    request("POST", `${base}/scripts`, { name }).then(
      () => {
        const ui = useUi.getState();
        if (!ui.terminalOpen) ui.togglePanel("terminal");
      },
      (failure: unknown) => pushToast(`Couldn't run ${name}. ${toFailure(failure).message}`),
    );
  };
  return list.map((script) => (
    <button key={script.name} type="button" className="detail-row" onClick={() => run(script.name)}>
      <Play size={16} aria-hidden />
      <span>{script.name}</span>
    </button>
  ));
}

function SideChatRows({ threadId }: { threadId: string }) {
  const threads = useWorkspace((state) => state.threads);
  const chats = useMemo(() => sideChatsOf(threads, threadId), [threads, threadId]);
  if (chats.length === 0) return null;
  return (
    <div className="details-section">
      <div className="details-head">
        <span>Side chats</span>
      </div>
      {chats.map((chat) => (
        <button key={chat.id} type="button" className="detail-row" onClick={() => showSideChat(chat.id)}>
          <MessagesSquare size={16} aria-hidden />
          <span>{chat.title}</span>
          <span className="detail-meta">{compactAge(chat.updated_at)}</span>
        </button>
      ))}
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

const MAX_PULL_ROWS = 3;

/** Automatic checks stay this far apart, however often the card appears. */
const LIMITS_CHECK_MS = 5 * 60 * 1000;
const lastLimits = new Map<string, { at: number; limits: Promise<EngineLimits> }>();

/** What's left of each limit window for this thread's engine, when it reports one. */
function LimitsRow({ threadId, engine }: { threadId: string; engine: string }) {
  const limits = useAsync(`details-limits:${engine}`, () => {
    const kept = lastLimits.get(engine);
    if (kept && Date.now() - kept.at < LIMITS_CHECK_MS) return kept.limits;
    const fresh = api.threadLimits(threadId);
    lastLimits.set(engine, { at: Date.now(), limits: fresh });
    fresh.catch(() => lastLimits.delete(engine));
    return fresh;
  });
  const windows = limits.data?.windows ?? [];
  if (windows.length === 0) return null;
  return (
    <div className="detail-row detail-row-static">
      <Gauge size={16} aria-hidden />
      <span>{windows.map((window) => `${window.label} ${Math.max(100 - Math.round(window.used_percent), 0)}% left`).join(", ")}</span>
    </div>
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
  const hidden = useUi((state) => state.detailsHidden);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const shows = (row: string) => !hidden.includes(row);
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
    <aside
      className="details"
      aria-label="Thread details"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {menu ? <Menu {...menu} label="Thread details rows" items={detailsMenuItems()} onClose={() => setMenu(null)} /> : null}
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
        {branch && shows("branch") ? <BranchRow thread={thread} branch={branch} /> : null}
        {shows("changes") ? <ChangesRow threadId={thread.id} /> : null}
        {shows("pulls") ? <PullRows threadId={thread.id} /> : null}
        {shows("servers") ? <ServersRow threadId={thread.id} /> : null}
        {shows("limits") ? <LimitsRow threadId={thread.id} engine={thread.engine} /> : null}
        {shows("usage") ? <UsageRow threadId={thread.id} /> : null}
        {shows("scripts") ? <ScriptRows threadId={thread.id} /> : null}
        {shows("editor") ? <OpenInEditor threadId={thread.id} /> : null}
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
      <SideChatRows threadId={thread.id} />
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
