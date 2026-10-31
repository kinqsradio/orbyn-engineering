import type { ReasoningItem, RunSpan, ThreadItem, ToolItem } from "./projection";
import { workDuration } from "./toolTrace";

export type WorkItem = ReasoningItem | ToolItem;

/** Neighbouring tool calls and reasoning, read as one line until opened. */
export interface WorkGroup {
  kind: "work";
  key: string;
  items: WorkItem[];
}

/** A finished turn's working: everything but the prompt and the answer. */
export interface TurnFold {
  kind: "fold";
  key: string;
  label: string;
  entries: TimelineEntry[];
}

/** The live header while a turn runs. */
export interface WorkingRow {
  kind: "working";
  key: string;
  since: string;
}

type Shown = Exclude<ThreadItem, WorkItem>;
export type TimelineEntry = Shown | WorkGroup | TurnFold | WorkingRow;

const isWork = (item: ThreadItem): item is WorkItem => item.kind === "reasoning" || item.kind === "tool";

/** Folds consecutive reasoning and tool calls into one work group. */
export function groupWork(items: readonly ThreadItem[]): (Shown | WorkGroup)[] {
  const entries: (Shown | WorkGroup)[] = [];
  let run: WorkItem[] = [];
  const close = () => {
    const first = run[0];
    if (first) entries.push({ kind: "work", key: `work:${first.key}`, items: run });
    run = [];
  };
  for (const item of items) {
    if (isWork(item)) {
      run.push(item);
    } else {
      close();
      entries.push(item);
    }
  }
  close();
  return entries;
}

/** Stays in view after a turn: a question still open, a failure, the files it changed. */
const staysVisible = (item: ThreadItem): boolean => {
  switch (item.kind) {
    case "approval":
      return item.approval.state === "pending";
    case "notice":
      return item.tone === "error";
    case "diff":
      return true;
    case "message":
      return item.role === "user";
    default:
      return false;
  }
};

function foldLabel(span: RunSpan | undefined, items: readonly ThreadItem[]): string {
  const start = span?.startedAt ?? items[0]?.ts;
  const end = span?.endedAt ?? items.at(-1)?.ts;
  const ms = start && end ? new Date(end).getTime() - new Date(start).getTime() : Number.NaN;
  const duration = Number.isFinite(ms) ? workDuration(ms) : null;
  if (span?.outcome === "cancelled") return duration ? `You stopped after ${duration}` : "You stopped this response";
  return duration ? `Worked for ${duration}` : "Worked";
}

function arrangeTurn(items: readonly ThreadItem[], runId: string, span: RunSpan | undefined, live: boolean): TimelineEntry[] {
  const lead = items.findIndex((item) => item.kind !== "message" || item.role !== "user");
  const prompts = lead === -1 ? items : items.slice(0, lead);
  const body = lead === -1 ? [] : items.slice(lead);
  if (live) {
    const since = span?.startedAt ?? body[0]?.ts ?? prompts[0]?.ts;
    return [
      ...groupWork(prompts),
      ...(since ? [{ kind: "working" as const, key: `working:${runId}`, since }] : []),
      ...groupWork(body),
    ];
  }
  let answer = -1;
  body.forEach((item, at) => {
    if (item.kind === "message" && item.role !== "user") answer = at;
  });
  const hidden = body.filter((item, at) => at !== answer && !staysVisible(item));
  if (hidden.length === 0) return groupWork(items);
  const shown = body.filter((item, at) => at === answer || staysVisible(item));
  return [
    ...groupWork(prompts),
    { kind: "fold", key: `fold:${runId}`, label: foldLabel(span, items), entries: groupWork(hidden) },
    ...groupWork(shown),
  ];
}

/** Turns the log into rows: each finished turn folds, the running one stays open. */
export function arrangeTimeline(
  items: readonly ThreadItem[],
  runs: Readonly<Record<string, RunSpan>>,
  activeRunId: string | null,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let turn: ThreadItem[] = [];
  let current: string | null = null;
  const close = () => {
    if (turn.length === 0) return;
    if (current === null) {
      entries.push(...groupWork(turn));
    } else {
      const span = runs[current];
      const live = current === activeRunId || (span !== undefined && span.endedAt === null);
      entries.push(...arrangeTurn(turn, current, span, live));
    }
    turn = [];
  };
  for (const item of items) {
    if (item.runId !== current) {
      close();
      current = item.runId;
    }
    turn.push(item);
  }
  close();
  return entries;
}

/** The row that shows a message, or the fold that holds it. */
export function entryForMessage(entries: readonly TimelineEntry[], messageId: string): string | null {
  const holds = (entry: TimelineEntry): boolean =>
    entry.kind === "fold"
      ? entry.entries.some(holds)
      : entry.kind === "message" && (entry.key === `msg:${messageId}` || entry.key.endsWith(`:${messageId}`));
  return entries.find(holds)?.key ?? null;
}

export const runningTools = (items: readonly ThreadItem[]): ToolItem[] =>
  items.filter((item): item is ToolItem => item.kind === "tool" && item.result === null && !item.done);

/** Offers older rows on demand so a long run stays light. */
export const LIVE_ROW_LIMIT = 30;

/** The row that shows an item, inside a fold or on its own. */
export function entryIndexOf(entries: readonly TimelineEntry[], key: string): number {
  const holds = (entry: TimelineEntry): boolean =>
    entry.kind === "fold" ? entry.entries.some(holds) : entry.key === key;
  return entries.findIndex(holds);
}

/**
 * The first reply between your last visit and this one, unless the whole conversation
 * is new. Anything after `arrivedAt` you watched arrive, so it never moves the line.
 */
export function firstUnread(items: readonly ThreadItem[], readUpTo: string | null, arrivedAt: string): string | null {
  if (!readUpTo) return null;
  const replies = items.filter((item) => item.kind === "message" && item.role === "assistant");
  const first = replies.find((item) => item.ts > readUpTo && item.ts < arrivedAt);
  return first && first !== replies[0] ? first.key : null;
}
