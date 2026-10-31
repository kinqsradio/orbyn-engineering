import { MessageActions } from "./MessageActions";
import {
  AppWindow,
  Brain,
  Check,
  ChevronRight,
  CircleDashed,
  Eye,
  FileDiff as FileDiffIcon,
  Globe,
  Hammer,
  Loader2,
  OctagonAlert,
  Search,
  SquarePen,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { createContext, memo, use, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { clockTime, elapsed, prettyJson } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { useNow } from "../../lib/useNow";
import { EngineGlyph } from "../../ui/badges";
import { Collapsible } from "../../ui/Collapsible";
import { Dialog } from "../../ui/Dialog";
import { useUi } from "../../state/ui";
import { Button, Pill } from "../../ui/controls";
import { outputSpans } from "./ansi";
import { ApprovalCard, useResolvedApproval } from "./ApprovalCard";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { PlanCard } from "./PlanCard";
import { proposedPlanIn, textAroundPlan } from "./proposedPlan";
import {
  LIVE_ROW_LIMIT,
  type TimelineEntry,
  type TurnFold,
  type WorkGroup,
  type WorkingRow,
  type WorkItem,
} from "./timeline";
import { summarizeWork, toolFailed, traceTool, type ToolAction } from "./toolTrace";
import type {
  ActivityItem,
  ApprovalItem,
  DiffSummaryItem,
  MessageItem,
  NoticeItem,
  PlanItem,
  ReasoningItem,
  ToolItem,
} from "./projection";

/** Which thread the timeline below it belongs to. */
export const TimelineThread = createContext<string | null>(null);
const useThreadOfTimeline = () => use(TimelineThread);

function Message({ item, live }: { item: MessageItem; live: boolean }) {
  if (item.role === "user") {
    return (
      <div className="msg-user" data-minimap={item.key}>
        <span className="sr-only">You said:</span>
        <p className="msg-bubble">{item.text}</p>
        <MessageActions text={item.text} runId={item.runId} role="user" />
      </div>
    );
  }
  const plan = item.done ? proposedPlanIn(item.text) : null;
  return (
    <div className="msg-assistant">
      {plan ? (
        <>
          {textAroundPlan(item.text) ? <Markdown text={textAroundPlan(item.text)} /> : null}
          <PlanCard text={plan} />
        </>
      ) : (
        <Markdown text={item.text} />
      )}
      {live && !item.done ? <span className="caret" aria-hidden /> : null}
      {item.done ? <MessageActions text={item.text} runId={item.runId} role="assistant" /> : null}
    </div>
  );
}

function Reasoning({ item, live }: { item: ReasoningItem; live: boolean }) {
  const streaming = live && !item.done;
  return (
    <Collapsible
      className="trace"
      summaryClassName="trace-summary"
      summary={
        <>
          <Brain size={14} aria-hidden />
          <span className={streaming ? "trace-label text-sweep" : "trace-label"}>
            {streaming ? "Thinking" : "Thought"}
          </span>
          <ChevronRight size={14} className="chev trace-end" aria-hidden />
        </>
      }
    >
      <div className="trace-body trace-prose">{item.text}</div>
    </Collapsible>
  );
}

const ACTION_ICONS: Record<ToolAction | "mixed" | "reasoning", LucideIcon> = {
  command: SquareTerminal,
  edit: SquarePen,
  read: Eye,
  web: Globe,
  "code-search": Search,
  browser: AppWindow,
  other: Wrench,
  mixed: Hammer,
  reasoning: Brain,
};

function CommandOutput({ item, running }: { item: ToolItem; running: boolean }) {
  const scroller = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const text = item.result ?? item.output;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  });
  if (!text) {
    return running ? null : <p className="tool-empty">No output.</p>;
  }
  return (
    <pre
      ref={scroller}
      tabIndex={0}
      className="tool-output"
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
      }}
    >
      {outputSpans(text).map((span, at) =>
        span.color || span.bold ? (
          <span key={at} style={{ color: span.color ?? undefined, fontWeight: span.bold ? 600 : undefined }}>
            {span.text}
          </span>
        ) : (
          span.text
        ),
      )}
    </pre>
  );
}

function ItemDetails({ threadId, id }: { threadId: string; id: string }) {
  const raw = useAsync(`item:${threadId}:${id}`, (signal) => api.threadItem(threadId, id, signal));
  if (raw.error) return <p className="tool-empty">Not recorded for this item.</p>;
  return (
    <pre tabIndex={0} className="tool-output">
      {raw.data ? JSON.stringify(raw.data, null, 2) : "Loading..."}
    </pre>
  );
}

function InspectItem({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const threadId = useThreadOfTimeline();
  if (!threadId) return null;
  return (
    <>
      <button type="button" className="inline-link tool-inspect" onClick={() => setOpen(true)}>
        Inspect item
      </button>
      {open ? (
        <Dialog title="Item details" onClose={() => setOpen(false)}>
          <ItemDetails threadId={threadId} id={item.callId} />
        </Dialog>
      ) : null}
    </>
  );
}

function Tool({ item, live }: { item: ToolItem; live: boolean }) {
  const finished = item.result !== null || item.done;
  const running = live && !finished;
  const trace = traceTool(item);
  const failed = toolFailed(item);
  const Icon = ACTION_ICONS[trace.action];
  const timestampFormat = useUi((state) => state.timestampFormat);
  return (
    <Collapsible
      className="trace"
      data-live={running || undefined}
      summaryClassName="trace-summary"
      summary={
        <>
          <Icon size={14} aria-hidden />
          <span className={running ? "trace-label text-sweep" : "trace-label"} title={trace.label}>
            {trace.label}
          </span>
          {running ? <span className="sr-only">Running</span> : null}
          {failed ? <X size={14} className="trace-failed" role="img" aria-label="Tool call failed" /> : null}
          <span className="trace-time" aria-hidden>
            {clockTime(item.ts, timestampFormat)}
          </span>
          <ChevronRight size={14} className="chev trace-end" aria-hidden />
        </>
      }
    >
      <div className="trace-body">
        {trace.command ? (
          <CodeBlock code={trace.command} lang="bash" bare />
        ) : (
          <pre tabIndex={0}>{prettyJson(item.args) || "None"}</pre>
        )}
        <CommandOutput item={item} running={running} />
        {item.exitCode !== null ? <p className="tool-exit" data-failed={failed || undefined}>Exit code {item.exitCode}</p> : null}
        {finished ? <InspectItem item={item} /> : null}
      </div>
    </Collapsible>
  );
}

function ApprovalEntry({ item }: { item: ApprovalItem }) {
  const approval = useResolvedApproval(item.approval);
  return <ApprovalCard approval={approval} />;
}

const stepDone = (status: string | null) => status === "completed" || status === "done";
const stepActive = (status: string | null) => status === "in_progress" || status === "running";

function Plan({ item, live }: { item: PlanItem; live: boolean }) {
  if (item.steps.length === 0) return null;
  return (
    <section className="plan" aria-label="Plan">
      <h3>Plan</h3>
      <ol>
        {item.steps.map((step, at) => (
          <li key={at} data-state={stepDone(step.status) ? "done" : stepActive(step.status) ? "active" : "todo"}>
            {stepDone(step.status) ? (
              <Check size={16} aria-hidden />
            ) : stepActive(step.status) && live ? (
              <Loader2 size={16} className="spin" aria-hidden />
            ) : (
              <CircleDashed size={16} aria-hidden />
            )}
            <span>{step.text}</span>
            {step.status ? <span className="sr-only">({step.status.replaceAll("_", " ")})</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChangedFile({ file }: { file: DiffSummaryItem["files"][number] }) {
  const revealDiff = useUi((state) => state.revealDiff);
  return (
    <li>
      <button type="button" onClick={() => revealDiff(file.path)}>
        <span title={file.path}>{file.path}</span>
        {file.additions !== null ? <span className="diff-add">+{file.additions}</span> : null}
        {file.deletions !== null ? <span className="diff-del">-{file.deletions}</span> : null}
      </button>
    </li>
  );
}

function DiffSummary({ item }: { item: DiffSummaryItem }) {
  const openPanel = useUi((state) => state.togglePanel);
  const panelShowing = useUi((state) => state.panelOpen === true && state.panelTab === "diff");
  const [open, setOpen] = useState(false);
  const added = item.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const removed = item.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <div className="diff-card">
      <div className="diff-summary">
        <FileDiffIcon size={16} aria-hidden />
        <button type="button" className="diff-count" aria-expanded={open} onClick={() => setOpen(!open)}>
          {item.files.length === 1 ? "1 file changed" : `${item.files.length} files changed`}
        </button>
        <span className="diff-add">+{added}</span>
        <span className="diff-del">-{removed}</span>
        <Button
          small
          tone="quiet"
          onClick={() => {
            if (!panelShowing) openPanel("diff");
          }}
        >
          View diff
        </Button>
      </div>
      {open ? (
        <ul className="changed-files" aria-label="Changed files">
          {item.files.map((file) => (
            <ChangedFile key={file.path} file={file} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Activity({ item }: { item: ActivityItem }) {
  return (
    <Collapsible
      className="trace"
      summaryClassName="trace-summary"
      summary={
        <>
          <ChevronRight size={14} className="chev" aria-hidden />
          <span className="trace-label">{item.activityType}</span>
        </>
      }
    >
      <div className="trace-body">
        <pre tabIndex={0}>{JSON.stringify(item.content, null, 2)}</pre>
      </div>
    </Collapsible>
  );
}

function Notice({ item }: { item: NoticeItem }) {
  if (item.tone === "neutral") {
    return <p className="notice">{item.text}</p>;
  }
  return (
    <div className="notice-error" role="alert">
      <OctagonAlert size={16} aria-hidden />
      <div>
        <strong>Run failed</strong>
        <p>{item.text}</p>
        {item.code ? <Pill>{item.code}</Pill> : null}
      </div>
    </div>
  );
}

function WorkEntry({ item, live }: { item: WorkItem; live: boolean }) {
  return item.kind === "reasoning" ? <Reasoning item={item} live={live} /> : <Tool item={item} live={live} />;
}

function RunningStack({ tools }: { tools: ToolItem[] }) {
  const now = useNow(true);
  const oldest = tools[0];
  const shown = tools.slice(0, 3);
  return (
    <div className="tool-stack">
      <span className="tool-avatars" aria-hidden>
        {shown.map((tool) => (
          <EngineGlyph key={tool.key} name={tool.name} />
        ))}
        {tools.length > shown.length ? <span className="tool-more">+{tools.length - shown.length}</span> : null}
      </span>
      <span className="tool-stack-text">
        <strong>{tools.length} tools</strong>
        <span className="tone-info">{tools.length} working</span>
      </span>
      {oldest ? <span className="tool-stack-time">{elapsed(oldest.ts, now)}</span> : null}
    </div>
  );
}

/** One call shows as its own row; several read as one summary until opened. */
export function WorkGroupView({ group, live }: { group: WorkGroup; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const only = group.items[0];
  if (group.items.length === 1 && only) {
    return (
      <section className="work-rows" aria-label="Activity">
        <WorkEntry item={only} live={live} />
      </section>
    );
  }
  const { summary, action, failed } = summarizeWork(group.items);
  const Icon = ACTION_ICONS[action];
  const hiddenRows = all ? 0 : Math.max(group.items.length - LIVE_ROW_LIMIT, 0);
  return (
    <section className="work-rows" aria-label="Activity">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="trace"
        summaryClassName="trace-summary"
        summary={
          <>
            <Icon size={14} aria-hidden />
            <span className="trace-label">{failed ? `${summary}, tool call failed` : summary}</span>
            {failed ? <X size={14} className="trace-failed" aria-hidden /> : null}
            <ChevronRight size={14} className="chev trace-end" aria-hidden />
          </>
        }
      >
        <div className="work-log" role="region" aria-label="Tool calls" tabIndex={0}>
          {hiddenRows > 0 ? (
            <button type="button" className="inline-link" onClick={() => setAll(true)}>
              Show {hiddenRows} earlier
            </button>
          ) : null}
          {group.items.slice(hiddenRows).map((item) => (
            <WorkEntry key={item.key} item={item} live={live} />
          ))}
        </div>
      </Collapsible>
    </section>
  );
}

/** The running turn's header, with a rule beneath it. */
function Working({ row, tools }: { row: WorkingRow; tools: ToolItem[] }) {
  const now = useNow(true);
  return (
    <div className="work">
      <p className="work-summary" role="status">
        Working for {elapsed(row.since, now)}
      </p>
      <hr />
      {tools.length > 1 ? <RunningStack tools={tools} /> : null}
    </div>
  );
}

/** The summary of a finished turn; what it hides stays mounted for find. */
function Fold({ fold }: { fold: TurnFold }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="work">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        summaryClassName="work-summary"
        summary={
          <>
            <span>{fold.label}</span>
            <ChevronRight size={14} className="chev" aria-hidden />
          </>
        }
      >
        <div className="work-fold">
          {fold.entries.map((entry) => (
            <TimelineRow key={entry.key} entry={entry} live={false} tools={NO_TOOLS} />
          ))}
        </div>
      </Collapsible>
      <hr />
    </div>
  );
}

const NO_TOOLS: ToolItem[] = [];

export function TimelineRow({ entry, live, tools }: { entry: TimelineEntry; live: boolean; tools: ToolItem[] }) {
  switch (entry.kind) {
    case "work":
      return <WorkGroupView group={entry} live={live} />;
    case "fold":
      return <Fold fold={entry} />;
    case "working":
      return <Working row={entry} tools={tools} />;
    default:
      return <ThreadItemView item={entry} live={live} />;
  }
}

function ItemView({ item, live }: { item: Exclude<TimelineEntry, WorkGroup | TurnFold | WorkingRow>; live: boolean }) {
  switch (item.kind) {
    case "message":
      return <Message item={item} live={live} />;
    case "approval":
      return <ApprovalEntry item={item} />;
    case "plan":
      return <Plan item={item} live={live} />;
    case "diff":
      return <DiffSummary item={item} />;
    case "notice":
      return <Notice item={item} />;
    case "activity":
      return <Activity item={item} />;
  }
}

export const ThreadItemView = memo(ItemView);
