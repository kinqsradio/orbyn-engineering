import { AlarmClock, Check, CircleCheck, CircleDashed, Clock, GitBranch, Pin, PinOff, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Project, Thread } from "../../api/types";
import { compactAge, elapsed, runStateLabels } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { routeHref } from "../../state/route";
import { engineById, useWorkspace } from "../../state/workspace";
import { EngineGlyph, ProjectBadge } from "../../ui/badges";
import type { DropVerb, SidebarSection } from "./groups";
import { threadRunState } from "./RunState";

const DONE_WINDOW_MS = 5 * 60_000;
const HOVER_DELAY_MS = 150;

const VERB_BADGE: Record<DropVerb, { label: string; icon: ReactNode }> = {
  pin: { label: "Pin", icon: <Pin size={12} aria-hidden /> },
  unpin: { label: "Unpin", icon: <PinOff size={12} aria-hidden /> },
  settle: { label: "Settle", icon: <CircleCheck size={12} aria-hidden /> },
  unsettle: { label: "Un-settle", icon: <CircleCheck size={12} aria-hidden /> },
  wake: { label: "Wake", icon: <Clock size={12} aria-hidden /> },
};

interface RowStatus {
  /** Leading 14px glyph: spinner, amber dot or red x. Nothing for idle and settled rows. */
  glyph: ReactNode;
  /** Trailing text: a short status word, or the relative age. */
  text: ReactNode;
  /** Why the person is needed, for lists that show only that: lower case, or null. */
  reason: "approval" | "question" | "limit" | null;
  running: boolean;
}

function useRowStatus(thread: Thread): RowStatus {
  const active = thread.active_run;
  const now = useNow(active !== null);
  const approvals = useWorkspace((state) => state.approvals.data);
  if (active) {
    if (active.state === "awaiting_approval") {
      const asking = approvals && !approvals.some((approval) => approval.thread_id === thread.id);
      return {
        glyph: <span className="status-dot tone-warn" aria-hidden />,
        text: <span className="row-status tone-warn">{asking ? "Question" : "Approval"}</span>,
        reason: asking ? "question" : "approval",
        running: false,
      };
    }
    const label = active.state === "admitted" ? "Queued" : thread.goal ? "Goal" : "Working";
    return {
      glyph: <CircleDashed size={14} className="spin" aria-hidden />,
      text: (
        <span className="row-status">
          {label} {elapsed(active.started_at, now)}
        </span>
      ),
      reason: null,
      running: true,
    };
  }
  if (thread.lifecycle?.limit) {
    return {
      glyph: <span className="status-dot tone-warn" aria-hidden />,
      text: <span className="row-status tone-warn">Limited</span>,
      reason: "limit",
      running: false,
    };
  }
  const state = thread.last_run_state;
  if (state === "failed") {
    return {
      glyph: <X size={14} className="tone-danger" aria-hidden />,
      text: <span className="row-status tone-danger">Failed</span>,
      reason: null,
      running: false,
    };
  }
  if (state === "interrupted") {
    return { glyph: null, text: <span className="row-status">Interrupted</span>, reason: null, running: false };
  }
  const fresh =
    thread.lifecycle?.unread ?? Date.now() - new Date(thread.updated_at).getTime() < DONE_WINDOW_MS;
  if (state === "completed" && fresh) {
    return { glyph: null, text: <span className="row-status">Done</span>, reason: null, running: false };
  }
  return {
    glyph: null,
    text: (
      <time className="row-age" dateTime={thread.updated_at}>
        {compactAge(thread.updated_at)}
      </time>
    ),
    reason: null,
    running: false,
  };
}

/** Details for a row, beside it, after a short delay. Pointer only. */
function ThreadHoverCard({
  thread,
  projectName,
  project,
  branch,
  engineName,
  anchor,
}: {
  thread: Thread;
  projectName: string;
  project?: Project;
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
          <ProjectBadge name={projectName} project={thread.scratch ? undefined : project} />
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

export interface RowActions {
  onClick(event: React.MouseEvent, thread: Thread): void;
  onPressStart(event: ReactPointerEvent, thread: Thread, section: SidebarSection): void;
  onActionPress(event: ReactPointerEvent, thread: Thread, section: SidebarSection): void;
  onMenu(event: { clientX: number; clientY: number }, thread: Thread): void;
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
  compact: _compact,
  multiline,
  multiSelected,
  focusable,
  dragging,
  highlighted,
  nested = false,
  showProject = false,
  ledger = false,
  verb,
  actions,
  jumpHint,
}: {
  /** A row under its project folder: indented, status at the right. */
  nested?: boolean;
  /** Names the project beside the title, for lists that are not grouped by project. */
  showProject?: boolean;
  /** Ledger's short form: the reason in lower case, a spinner for running, otherwise the project. */
  ledger?: boolean;
  /** Shown while the jump modifier is held. */
  jumpHint?: number | null;
  thread: Thread;
  section: SidebarSection;
  selected: boolean;
  compact: boolean;
  multiline: boolean;
  multiSelected: boolean;
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
  const status = useRowStatus(thread);
  const details = [
    projectName,
    branch,
    thread.model ? `${engineName}, ${thread.model}` : engineName,
  ]
    .filter(Boolean)
    .join(" · ");
  // Project, branch and engine left the visible row; screen readers and keyboard users get them here.
  const detailsId = `thread-row-details-${thread.id}`;
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
              ledger
                ? status.reason
                  ? <span className="row-status tone-warn">{status.reason}</span>
                  : null
                : status.text
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
      <AlarmClock size={10} aria-hidden />
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

  const title = <span className="thread-row-title">{thread.title}</span>;

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
        className="thread-row"
        title={details}
        aria-describedby={detailsId}
        data-unread={unread || undefined}
        data-multiline={multiline || undefined}
        data-nested={nested || undefined}
        href={routeHref({ name: "thread", id: thread.id })}
        aria-current={selected ? "page" : undefined}
        tabIndex={focusable ? 0 : -1}
        draggable={false}
        onClick={(event) => actions.onClick(event, thread)}
        onPointerDown={(event) => {
          stopHover();
          actions.onPressStart(event, thread, section);
        }}
        onFocus={(event) => {
          actions.onRowFocus(thread.id);
          if (!event.currentTarget.matches(":focus-visible")) return;
          const rect = event.currentTarget.getBoundingClientRect();
          timer.current = setTimeout(() => setHover(rect), HOVER_DELAY_MS);
        }}
        onBlur={stopHover}
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
        <span className="row-glyph">{status.glyph}</span>
        {title}
        {wokeMark}
        {pinMark}
        {unmanaged ? (
          <span className="thread-row-project">Unmanaged</span>
        ) : thread.scratch || showProject || (ledger && !status.reason && !status.running) ? (
          <span className="thread-row-project">{projectName}</span>
        ) : null}
        {trailing}
      </a>
      <span id={detailsId} className="sr-only">
        {details}
      </span>
      {hover && !dragging ? (
        <ThreadHoverCard
          thread={thread}
          projectName={projectName}
          project={project}
          branch={branch}
          engineName={engineName}
          anchor={hover}
        />
      ) : null}
    </li>
  );
}
