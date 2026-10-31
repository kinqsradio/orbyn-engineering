import {
  Check,
  CircleCheck,
  CircleDashed,
  Clock,
  Gauge,
  GitBranch,
  OctagonAlert,
  Pin,
  PinOff,
  Unplug,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Thread } from "../../api/types";
import { compactAge, elapsed, runStateLabels } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { routeHref } from "../../state/route";
import { engineById, useWorkspace } from "../../state/workspace";
import { EngineGlyph, ProjectBadge } from "../../ui/badges";
import type { DropVerb, SidebarSection } from "./groups";
import { threadRunState } from "./RunState";
import { renameThread } from "./threadActions";

const DONE_WINDOW_MS = 5 * 60_000;
const HOVER_DELAY_MS = 150;

const VERB_BADGE: Record<DropVerb, { label: string; icon: ReactNode }> = {
  pin: { label: "Pin", icon: <Pin size={12} aria-hidden /> },
  unpin: { label: "Unpin", icon: <PinOff size={12} aria-hidden /> },
  settle: { label: "Settle", icon: <CircleCheck size={12} aria-hidden /> },
  unsettle: { label: "Un-settle", icon: <CircleCheck size={12} aria-hidden /> },
  wake: { label: "Wake", icon: <Clock size={12} aria-hidden /> },
};

function RowStatus({ thread }: { thread: Thread }) {
  const active = thread.active_run;
  const now = useNow(active !== null);
  const approvals = useWorkspace((state) => state.approvals.data);
  if (active) {
    if (active.state === "awaiting_approval") {
      const asking = approvals && !approvals.some((approval) => approval.thread_id === thread.id);
      return (
        <span className="row-status tone-warn">
          <span className="status-dot" aria-hidden />
          {asking ? "Question" : "Approval"}
        </span>
      );
    }
    const label = active.state === "admitted" ? "Queued" : thread.goal ? "Goal" : "Working";
    return (
      <span className="row-status tone-info">
        <CircleDashed size={14} className="spin" aria-hidden />
        {label} {elapsed(active.started_at, now)}
      </span>
    );
  }
  if (thread.lifecycle?.limit) {
    return (
      <span className="row-status tone-warn">
        <Gauge size={14} aria-hidden />
        Limited
      </span>
    );
  }
  const state = thread.last_run_state;
  if (state === "failed") {
    return (
      <span className="row-status tone-danger">
        <OctagonAlert size={14} aria-hidden />
        Failed
      </span>
    );
  }
  if (state === "interrupted") {
    return (
      <span className="row-status tone-warn">
        <Unplug size={14} aria-hidden />
        Interrupted
      </span>
    );
  }
  const fresh =
    thread.lifecycle?.unread ?? Date.now() - new Date(thread.updated_at).getTime() < DONE_WINDOW_MS;
  if (state === "completed" && fresh) {
    return (
      <span className="row-status tone-success">
        <CircleCheck size={14} aria-hidden />
        Done
      </span>
    );
  }
  return (
    <time className="row-age" dateTime={thread.updated_at}>
      {compactAge(thread.updated_at)}
    </time>
  );
}

/** Details for a row, beside it, after a short delay. Pointer only. */
function ThreadHoverCard({
  thread,
  projectName,
  branch,
  engineName,
  anchor,
}: {
  thread: Thread;
  projectName: string;
  branch: string | null;
  engineName: string;
  anchor: DOMRect;
}) {
  const state = threadRunState(thread);
  return createPortal(
    <div className="hover-card" role="tooltip" style={{ left: anchor.right + 4, top: anchor.top }}>
      <p className="hover-card-title">{thread.title}</p>
      <div className="hover-card-rows">
        <div>
          <ProjectBadge name={projectName} />
          <span>{projectName}</span>
        </div>
        {branch ? (
          <div>
            <GitBranch size={12} aria-hidden />
            <span>{branch}</span>
          </div>
        ) : null}
        <div>
          <EngineGlyph name={engineName} />
          <span>{thread.model ? `${engineName}, ${thread.model}` : engineName}</span>
        </div>
        {state ? (
          <div>
            <Clock size={12} aria-hidden />
            <span>
              {runStateLabels[state]}, {compactAge(thread.updated_at)}
            </span>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function TitleEditor({ thread, onDone }: { thread: Thread; onDone(): void }) {
  const [value, setValue] = useState(thread.title);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = value.trim();
    if (save && next && next !== thread.title) void renameThread(thread, next);
    onDone();
  };
  return (
    <input
      className="thread-row-rename"
      aria-label="Thread title"
      value={value}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onClick={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
    />
  );
}

export interface RowActions {
  onClick(event: React.MouseEvent, thread: Thread): void;
  onPressStart(event: ReactPointerEvent, thread: Thread, section: SidebarSection): void;
  onActionPress(event: ReactPointerEvent, thread: Thread, section: SidebarSection): void;
  onMenu(event: { clientX: number; clientY: number }, thread: Thread): void;
  onRenameDone(): void;
  onSettle(thread: Thread): void;
  onUnsettle(thread: Thread): void;
  onSnooze(event: { clientX: number; clientY: number }, thread: Thread): void;
  onWake(thread: Thread): void;
  onUnpin(thread: Thread): void;
  onRowFocus(id: string): void;
  onFiles(thread: Thread, files: File[]): void;
  onDismissWoke(thread: Thread): void;
}

export function ThreadRow({
  thread,
  section,
  selected,
  compact,
  multiline,
  multiSelected,
  renaming,
  focusable,
  dragging,
  highlighted,
  verb,
  actions,
  jumpHint,
}: {
  /** Shown while the jump modifier is held. */
  jumpHint?: number | null;
  thread: Thread;
  section: SidebarSection;
  selected: boolean;
  compact: boolean;
  multiline: boolean;
  multiSelected: boolean;
  renaming: boolean;
  focusable: boolean;
  dragging: boolean;
  highlighted: boolean;
  /** Set during a drag or a press-drag: what letting go does to this row. */
  verb: DropVerb | null;
  actions: RowActions;
}) {
  const project = useWorkspace((state) => state.projects.data?.find((p) => p.id === thread.project_id));
  const engine = useWorkspace((state) => engineById(state.engines.data, thread.engine));
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.targets.find((t) => t.project_id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const unmanaged = engine?.capabilities.managed === false;
  const projectName = thread.scratch ? "No project" : (project?.name ?? "Unknown project");
  const engineName = engine?.name ?? thread.engine;
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const lifecycle = thread.lifecycle;
  const pinned = Boolean(lifecycle?.pinned_at);
  const unread = lifecycle?.unread === true;
  const stopHover = () => {
    clearTimeout(timer.current);
    setHover(null);
  };

  const badge = verb ? (
    <span className="row-drop-badge" role="status">
      {VERB_BADGE[verb].icon}
      {VERB_BADGE[verb].label}
    </span>
  ) : null;

  const trailing = (
    <span className="row-trailing">
      {badge ?? (
        <>
          <span className="row-rest">
            {section === "snoozed" && lifecycle?.snoozed_until ? (
              <time className="row-age" dateTime={lifecycle.snoozed_until}>
                {compactAge(lifecycle.snoozed_until)}
              </time>
            ) : (
              <RowStatus thread={thread} />
            )}
          </span>
          <span className="row-actions">
            {section === "snoozed" ? (
              <button
                type="button"
                className="row-action"
                aria-label="Wake thread now"
                title="Wake thread now"
                onPointerDown={(event) => actions.onActionPress(event, thread, section)}
                onClick={(event) => {
                  event.preventDefault();
                  actions.onWake(thread);
                }}
              >
                <Clock size={14} aria-hidden />
              </button>
            ) : section === "settled" ? (
              <button
                type="button"
                className="row-action"
                aria-label="Un-settle thread"
                title="Un-settle thread"
                onPointerDown={(event) => actions.onActionPress(event, thread, section)}
                onClick={(event) => {
                  event.preventDefault();
                  actions.onUnsettle(thread);
                }}
              >
                <CircleCheck size={14} aria-hidden />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="row-action"
                  aria-label="Snooze thread"
                  title="Snooze thread"
                  onClick={(event) => {
                    event.preventDefault();
                    actions.onSnooze(event, thread);
                  }}
                >
                  <Clock size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  className="row-action"
                  aria-label="Settle thread"
                  title="Settle thread"
                  onPointerDown={(event) => actions.onActionPress(event, thread, section)}
                  onClick={(event) => {
                    event.preventDefault();
                    actions.onSettle(thread);
                  }}
                >
                  <Check size={14} aria-hidden />
                  Settle
                </button>
              </>
            )}
          </span>
        </>
      )}
    </span>
  );

  const wokeMark = lifecycle?.woke_at ? (
    <button
      type="button"
      className="row-woke"
      aria-label="Dismiss Woke"
      title="This thread woke early. Dismiss"
      onClick={(event) => {
        event.preventDefault();
        actions.onDismissWoke(thread);
      }}
    >
      Woke
      <X size={10} aria-hidden />
    </button>
  ) : null;

  const pinMark = pinned ? (
    <button
      type="button"
      className="row-pin"
      aria-label="Unpin thread"
      title="Unpin thread"
      onClick={(event) => {
        event.preventDefault();
        actions.onUnpin(thread);
      }}
    >
      <Pin size={12} aria-hidden />
    </button>
  ) : null;

  const title = renaming ? (
    <TitleEditor thread={thread} onDone={actions.onRenameDone} />
  ) : (
    <span className="thread-row-title">{thread.title}</span>
  );

  return (
    <li
      data-thread-item={thread.id}
      data-section={section}
      data-jump-hint={jumpHint ?? undefined}
      data-dragging={dragging || undefined}
      data-selected={multiSelected || undefined}
      data-highlight={highlighted || undefined}
      data-file-over={fileOver || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setFileOver(true);
      }}
      onDragLeave={() => setFileOver(false)}
      onDrop={(event) => {
        setFileOver(false);
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        actions.onFiles(thread, [...event.dataTransfer.files]);
      }}
    >
      <a
        className={compact ? "thread-row thread-row-compact" : "thread-row"}
        data-unread={unread || undefined}
        data-multiline={multiline || undefined}
        href={routeHref({ name: "thread", id: thread.id })}
        aria-current={selected ? "page" : undefined}
        tabIndex={focusable ? 0 : -1}
        draggable={false}
        onClick={(event) => actions.onClick(event, thread)}
        onPointerDown={(event) => {
          stopHover();
          actions.onPressStart(event, thread, section);
        }}
        onFocus={() => actions.onRowFocus(thread.id)}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          const rect = event.currentTarget.getBoundingClientRect();
          timer.current = setTimeout(() => setHover(rect), HOVER_DELAY_MS);
        }}
        onPointerLeave={stopHover}
        onContextMenu={(event) => {
          event.preventDefault();
          stopHover();
          actions.onMenu(event, thread);
        }}
      >
        {compact ? (
          <>
            <ProjectBadge name={projectName} />
            {title}
            {wokeMark}
            {pinMark}
            {trailing}
          </>
        ) : (
          <>
            <span className="thread-row-line">
              <ProjectBadge name={projectName} />
              <span className="thread-row-project">{projectName}</span>
              {wokeMark}
              {pinMark}
              {trailing}
            </span>
            {title}
            <span className="thread-row-line thread-row-foot">
              <span className="thread-row-branch">
                {branch ? (
                  <>
                    <GitBranch size={12} aria-hidden />
                    {branch}
                  </>
                ) : null}
              </span>
              {unmanaged ? <span className="row-age">Unmanaged</span> : null}
              <EngineGlyph name={engineName} />
            </span>
          </>
        )}
      </a>
      {hover && !dragging ? (
        <ThreadHoverCard
          thread={thread}
          projectName={projectName}
          branch={branch}
          engineName={engineName}
          anchor={hover}
        />
      ) : null}
    </li>
  );
}
