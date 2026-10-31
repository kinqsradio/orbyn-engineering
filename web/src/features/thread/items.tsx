import {
  Brain,
  Check,
  ChevronRight,
  CircleDashed,
  FileDiff as FileDiffIcon,
  Loader2,
  OctagonAlert,
  Wrench,
} from "lucide-react";
import { memo, useState } from "react";
import { elapsed, prettyJson } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { EngineGlyph } from "../../ui/badges";
import { Collapsible } from "../../ui/Collapsible";
import { useUi } from "../../state/ui";
import { Button, Pill } from "../../ui/controls";
import { ApprovalCard, useResolvedApproval } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { runningTools, type TimelineEntry, type WorkGroup, type WorkItem } from "./timeline";
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

function Message({ item, live }: { item: MessageItem; live: boolean }) {
  if (item.role === "user") {
    return (
      <div className="msg-user">
        <span className="sr-only">You said:</span>
        <p className="msg-bubble">{item.text}</p>
      </div>
    );
  }
  return (
    <div className="msg-assistant">
      <Markdown text={item.text} />
      {live && !item.done ? <span className="caret" aria-hidden /> : null}
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
          <ChevronRight size={14} className="chev" aria-hidden />
          <Brain size={14} aria-hidden />
          <span className={streaming ? "text-sweep" : undefined}>Reasoning</span>
        </>
      }
    >
      <div className="trace-body trace-prose">{item.text}</div>
    </Collapsible>
  );
}

const firstValue = (args: string): string => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object") {
      const value = Object.values(parsed).find((entry) => typeof entry === "string");
      if (typeof value === "string") return value;
    }
  } catch {
    // Arguments still streaming.
  }
  return "";
};

function Tool({ item, live }: { item: ToolItem; live: boolean }) {
  const finished = item.result !== null || item.done;
  const running = live && !finished;
  return (
    <Collapsible
      className="trace"
      data-live={running || undefined}
      summaryClassName="trace-summary"
      summary={
        <>
          <ChevronRight size={14} className="chev" aria-hidden />
          <Wrench size={14} aria-hidden />
          <span className={running ? "trace-name text-sweep" : "trace-name"}>{item.name}</span>
          <code className="trace-arg">{firstValue(item.args)}</code>
          {running ? (
            <span className="sr-only">Running</span>
          ) : finished ? (
            <Check size={14} className="trace-end" role="img" aria-label="Finished" />
          ) : (
            <CircleDashed size={14} className="trace-end" role="img" aria-label="No result" />
          )}
        </>
      }
    >
      <div className="trace-body">
        <h4>Arguments</h4>
        <pre tabIndex={0}>{prettyJson(item.args) || "None"}</pre>
        {item.result !== null || item.output ? (
          <>
            <h4>{item.result !== null ? "Result" : "Output"}</h4>
            <pre tabIndex={0} className="trace-result">
              {item.result ?? item.output}
            </pre>
          </>
        ) : null}
      </div>
    </Collapsible>
  );
}

function ApprovalEntry({ item, engine }: { item: ApprovalItem; engine: string | null }) {
  const approval = useResolvedApproval(item.approval);
  return <ApprovalCard approval={approval} engine={engine} />;
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

function DiffSummary({ item }: { item: DiffSummaryItem }) {
  const openPanel = useUi((state) => state.togglePanel);
  const panelShowing = useUi((state) => state.panelOpen === true && state.panelTab === "diff");
  const added = item.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const removed = item.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <div className="diff-summary">
      <FileDiffIcon size={16} aria-hidden />
      <span>
        {item.files.length === 1 ? "1 file changed" : `${item.files.length} files changed`}
      </span>
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
          <span className="trace-name">{item.activityType}</span>
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
  switch (item.kind) {
    case "reasoning":
      return <Reasoning item={item} live={live} />;
    case "tool":
      return <Tool item={item} live={live} />;
    case "activity":
      return <Activity item={item} />;
  }
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

export function WorkGroupView({
  group,
  live,
  latest,
}: {
  group: WorkGroup;
  live: boolean;
  /** The group the current run is writing to. */
  latest: boolean;
}) {
  const current = live && latest;
  const running = current ? runningTools(group.items) : [];
  const [open, setOpen] = useState(running.length === 1);
  const now = useNow(current);
  const started = group.items[0]?.ts;
  return (
    <div className="work">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        summaryClassName="work-summary"
        summary={
          <>
            <span>
              {current && started ? `Working for ${elapsed(started, now)}` : `Worked for ${group.seconds}s`}
            </span>
            <ChevronRight size={14} className="chev" aria-hidden />
          </>
        }
      >
        <div className="work-log">
          {group.items.map((item) => (
            <WorkEntry key={item.key} item={item} live={live} />
          ))}
        </div>
      </Collapsible>
      <hr />
      {running.length > 1 ? <RunningStack tools={running} /> : null}
    </div>
  );
}

function ItemView({
  item,
  live,
  engine,
}: {
  item: Exclude<TimelineEntry, WorkGroup>;
  live: boolean;
  engine: string | null;
}) {
  switch (item.kind) {
    case "message":
      return <Message item={item} live={live} />;
    case "approval":
      return <ApprovalEntry item={item} engine={engine} />;
    case "plan":
      return <Plan item={item} live={live} />;
    case "diff":
      return <DiffSummary item={item} />;
    case "notice":
      return <Notice item={item} />;
  }
}

export const ThreadItemView = memo(ItemView);
