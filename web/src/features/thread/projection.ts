import type {
  ActionKind,
  AgUiEvent,
  Approval,
  ApprovalState,
  JsonValue,
  WireThreadEvent,
} from "../../api/types";

interface ItemBase {
  key: string;
  seq: number;
  ts: string;
  runId: string | null;
}

export interface MessageItem extends ItemBase {
  kind: "message";
  role: string;
  text: string;
  done: boolean;
}
export interface ReasoningItem extends ItemBase {
  kind: "reasoning";
  text: string;
  done: boolean;
}
export interface ToolItem extends ItemBase {
  kind: "tool";
  /** The engine's id for the call, which the server's item record also uses. */
  callId: string;
  name: string;
  args: string;
  /** Output streamed while the tool runs, until its final result arrives. */
  output: string;
  result: string | null;
  done: boolean;
  /** What a command exited with, when the engine reports it. */
  exitCode: number | null;
}
export interface ApprovalItem extends ItemBase {
  kind: "approval";
  approval: Approval;
}
export interface PlanStep {
  text: string;
  status: string | null;
}
export interface PlanItem extends ItemBase {
  kind: "plan";
  steps: PlanStep[];
}
export interface DiffSummaryItem extends ItemBase {
  kind: "diff";
  files: { path: string; additions: number | null; deletions: number | null }[];
}
export interface ActivityItem extends ItemBase {
  kind: "activity";
  activityType: string;
  content: JsonValue;
}
export interface NoticeItem extends ItemBase {
  kind: "notice";
  tone: "error" | "neutral";
  text: string;
  code: string | null;
}

export type ThreadItem =
  | MessageItem
  | ReasoningItem
  | ToolItem
  | ApprovalItem
  | PlanItem
  | DiffSummaryItem
  | ActivityItem
  | NoticeItem;

export interface TimelineEntry {
  seq: number;
  ts: string;
  label: string;
  detail: string | null;
  tone: "neutral" | "error" | "attention";
}

/** One turn's span and how it ended, read from its own events. */
export interface RunSpan {
  startedAt: string;
  endedAt: string | null;
  outcome: "success" | "cancelled" | "failed" | null;
}

/** A delegated agent the engine reported on this thread's stream. */
export interface SubagentActivity {
  id: string;
  tool: string | null;
  status: string | null;
  agentPath: string | null;
}

export interface ThreadLog {
  /** Every accepted event, ascending by seq. */
  events: readonly WireThreadEvent[];
  seen: ReadonlySet<number>;
  lastSeq: number;
  items: readonly ThreadItem[];
  timeline: readonly TimelineEntry[];
  runs: Readonly<Record<string, RunSpan>>;
  subagents: readonly SubagentActivity[];
  /** The latest usage report, as the engine sent it. */
  usage: JsonValue | null;
}

export const emptyLog: ThreadLog = {
  events: [],
  seen: new Set(),
  lastSeq: 0,
  items: [],
  timeline: [],
  runs: {},
  subagents: [],
  usage: null,
};

function record(value: JsonValue | undefined): { [key in string]?: JsonValue } | null {
  if (value === undefined) return null;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

const ACTION_KINDS: readonly string[] = [
  "command",
  "file_change",
  "tool",
  "computer",
  "browser",
  "network",
] satisfies ActionKind[];
const APPROVAL_STATES: readonly string[] = [
  "pending",
  "allowed",
  "denied",
  "expired",
] satisfies ApprovalState[];

/** Reads an approval from an activity snapshot; null when it isn't one. */
export function approvalFromContent(
  content: JsonValue,
  threadId: string,
  runId: string | null,
  ts: string,
): Approval | null {
  const body = record(content);
  if (!body) return null;
  const id = body.id ?? body.approval_id;
  if (typeof id !== "string") return null;
  const str = (key: string) => {
    const value = body[key];
    return typeof value === "string" ? value : null;
  };
  const kind = str("kind");
  const state = str("state");
  return {
    id,
    thread_id: str("thread_id") ?? threadId,
    run_id: str("run_id") ?? runId ?? "",
    kind: kind && ACTION_KINDS.includes(kind) ? (kind as ActionKind) : "tool",
    summary: str("summary") ?? "Approval requested",
    detail: body.detail ?? null,
    state: state && APPROVAL_STATES.includes(state) ? (state as ApprovalState) : "pending",
    decided_by: str("decided_by"),
    decided_at: str("decided_at"),
    created_at: str("created_at") ?? ts,
  };
}

function planSteps(content: JsonValue): PlanStep[] {
  const body = record(content);
  const raw = Array.isArray(content)
    ? content
    : (body?.steps ?? body?.entries ?? body?.items ?? null);
  if (!Array.isArray(raw)) return [];
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      steps.push({ text: entry, status: null });
      continue;
    }
    const step = record(entry);
    if (!step) continue;
    const text = step.title ?? step.text ?? step.content ?? step.description;
    if (typeof text !== "string") continue;
    steps.push({ text, status: typeof step.status === "string" ? step.status : null });
  }
  return steps;
}

function diffFiles(content: JsonValue): DiffSummaryItem["files"] {
  const body = record(content);
  const raw = Array.isArray(content) ? content : (body?.files ?? null);
  if (!Array.isArray(raw)) return [];
  const files: DiffSummaryItem["files"] = [];
  for (const entry of raw) {
    const file = record(entry);
    if (!file || typeof file.path !== "string") continue;
    files.push({
      path: file.path,
      additions: typeof file.additions === "number" ? file.additions : null,
      deletions: typeof file.deletions === "number" ? file.deletions : null,
    });
  }
  return files;
}

function outcomeType(outcome: JsonValue | null): string | null {
  const body = outcome === null ? null : record(outcome);
  return typeof body?.type === "string" ? body.type : null;
}

/** Mutable working copy used while folding one batch. */
interface Fold {
  threadId: string;
  items: ThreadItem[];
  index: Map<string, number>;
  timeline: TimelineEntry[];
  runs: Record<string, RunSpan>;
  subagents: SubagentActivity[];
  usage: JsonValue | null;
}

function put(fold: Fold, item: ThreadItem): void {
  const at = fold.index.get(item.key);
  if (at === undefined) {
    fold.index.set(item.key, fold.items.length);
    fold.items.push(item);
  } else {
    fold.items[at] = item;
  }
}

function patch<K extends ThreadItem["kind"]>(
  fold: Fold,
  key: string,
  kind: K,
  update: (item: Extract<ThreadItem, { kind: K }>) => Extract<ThreadItem, { kind: K }>,
): void {
  const at = fold.index.get(key);
  if (at === undefined) return;
  const item = fold.items[at];
  if (item?.kind === kind) {
    fold.items[at] = update(item as Extract<ThreadItem, { kind: K }>);
  }
}

function applyEvent(fold: Fold, wire: WireThreadEvent): void {
  const event: AgUiEvent = wire.event;
  const base = { seq: wire.seq, ts: wire.ts, runId: wire.run_id };
  // Engines reuse ids between runs; each run keeps its own rows.
  const scoped = (kind: string, id: string) => `${kind}:${wire.run_id ?? ""}:${id}`;
  const log = (label: string, detail: string | null, tone: TimelineEntry["tone"] = "neutral") =>
    fold.timeline.push({ seq: wire.seq, ts: wire.ts, label, detail, tone });
  const endRun = (outcome: RunSpan["outcome"]) => {
    const id = wire.run_id;
    if (!id) return;
    const span = fold.runs[id];
    fold.runs[id] = { startedAt: span?.startedAt ?? wire.ts, endedAt: wire.ts, outcome };
  };

  switch (event.type) {
    case "RUN_STARTED":
      if (wire.run_id) fold.runs[wire.run_id] = { startedAt: wire.ts, endedAt: null, outcome: null };
      log("Run started", null);
      break;
    case "RUN_FINISHED": {
      const outcome = outcomeType(event.outcome);
      endRun(outcome === "cancelled" ? "cancelled" : "success");
      if (outcome === "cancelled") {
        put(fold, {
          ...base,
          key: `notice:${wire.seq}`,
          kind: "notice",
          tone: "neutral",
          text: "Run cancelled.",
          code: null,
        });
      }
      log(outcome === "cancelled" ? "Run cancelled" : "Run finished", null);
      break;
    }
    case "RUN_ERROR":
      endRun("failed");
      put(fold, {
        ...base,
        key: `notice:${wire.seq}`,
        kind: "notice",
        tone: "error",
        text: event.message,
        code: event.code,
      });
      log("Run failed", event.message, "error");
      break;
    case "TEXT_MESSAGE_START":
      put(fold, {
        ...base,
        key: scoped("msg", event.messageId),
        kind: "message",
        role: event.role,
        text: "",
        done: false,
      });
      break;
    case "TEXT_MESSAGE_CONTENT":
      patch(fold, scoped("msg", event.messageId), "message", (item) => ({
        ...item,
        text: item.text + event.delta,
      }));
      break;
    case "TEXT_MESSAGE_END":
      patch(fold, scoped("msg", event.messageId), "message", (item) => ({ ...item, done: true }));
      break;
    case "REASONING_MESSAGE_START":
      put(fold, {
        ...base,
        key: scoped("rsn", event.messageId),
        kind: "reasoning",
        text: "",
        done: false,
      });
      break;
    case "REASONING_MESSAGE_CONTENT":
      patch(fold, scoped("rsn", event.messageId), "reasoning", (item) => ({
        ...item,
        text: item.text + event.delta,
      }));
      break;
    case "REASONING_MESSAGE_END":
      patch(fold, scoped("rsn", event.messageId), "reasoning", (item) => ({ ...item, done: true }));
      break;
    case "TOOL_CALL_START":
      put(fold, {
        ...base,
        key: scoped("tool", event.toolCallId),
        kind: "tool",
        callId: event.toolCallId,
        name: event.toolCallName,
        args: "",
        output: "",
        result: null,
        done: false,
        exitCode: null,
      });
      log(`Tool: ${event.toolCallName}`, null);
      break;
    case "TOOL_CALL_ARGS":
      patch(fold, scoped("tool", event.toolCallId), "tool", (item) => ({
        ...item,
        args: item.args + event.delta,
      }));
      break;
    case "TOOL_CALL_END":
      patch(fold, scoped("tool", event.toolCallId), "tool", (item) => ({ ...item, done: true }));
      break;
    case "TOOL_CALL_RESULT":
      patch(fold, scoped("tool", event.toolCallId), "tool", (item) => ({
        ...item,
        result: event.content,
        done: true,
      }));
      break;
    case "ACTIVITY_SNAPSHOT": {
      const key = scoped("act", event.messageId);
      // AG-UI: `replace: false` keeps an activity that already exists.
      if (event.replace === false && fold.index.has(key)) break;
      const common = { ...base, key };
      if (event.activityType === "approval") {
        const approval = approvalFromContent(event.content, fold.threadId, wire.run_id, wire.ts);
        if (approval) {
          put(fold, { ...common, kind: "approval", approval });
          log(
            approval.state === "pending" ? "Approval requested" : `Approval ${approval.state}`,
            approval.summary,
            approval.state === "pending" ? "attention" : "neutral",
          );
          break;
        }
      }
      if (event.activityType === "plan") {
        put(fold, { ...common, kind: "plan", steps: planSteps(event.content) });
        log("Plan updated", null);
        break;
      }
      if (event.activityType === "diff") {
        const files = diffFiles(event.content);
        put(fold, { ...common, kind: "diff", files });
        log("Files changed", files.length === 1 ? "1 file" : `${files.length} files`);
        break;
      }
      const message = record(event.content)?.message;
      if (event.activityType === "unmanaged" && typeof message === "string") {
        put(fold, { ...common, kind: "notice", tone: "neutral", text: message, code: null });
        log("Unmanaged run", null, "attention");
        break;
      }
      put(fold, {
        ...common,
        kind: "activity",
        activityType: event.activityType,
        content: event.content,
      });
      log(event.activityType, null);
      break;
    }
    case "CUSTOM":
      if (event.name === "engine.retrying") {
        const message = record(event.value)?.message;
        log("Engine retrying", typeof message === "string" ? message : null, "attention");
      } else if (event.name === "tool.output") {
        const body = record(event.value);
        const delta = body?.delta;
        if (typeof body?.toolCallId === "string" && typeof delta === "string") {
          patch(fold, scoped("tool", body.toolCallId), "tool", (item) => ({
            ...item,
            output: item.output + delta,
          }));
        }
      } else if (event.name === "tool.finished") {
        const body = record(event.value);
        const code = body?.exitCode;
        if (typeof body?.toolCallId === "string" && typeof code === "number") {
          patch(fold, scoped("tool", body.toolCallId), "tool", (item) => ({ ...item, exitCode: code }));
        }
      } else if (event.name === "subagent.activity") {
        const body = record(event.value);
        const text = (key: string) => {
          const value = body?.[key];
          return typeof value === "string" ? value : null;
        };
        const id = text("id");
        if (id) {
          const next = { id, tool: text("tool"), status: text("status"), agentPath: text("agentPath") };
          fold.subagents = [...fold.subagents.filter((agent) => agent.id !== id), next];
        }
      } else if (event.name === "usage") {
        fold.usage = event.value;
      }
      break;
    case "RAW":
      break;
    default: {
      // An event type added on the server must not break an older client.
      const _unknown: never = event;
      void _unknown;
    }
  }
}

function fold(
  threadId: string,
  log: ThreadLog,
  events: readonly WireThreadEvent[],
  incremental: boolean,
): Pick<ThreadLog, "items" | "timeline" | "runs" | "subagents" | "usage"> {
  const working: Fold = incremental
    ? {
        threadId,
        items: [...log.items],
        index: new Map(log.items.map((item, at) => [item.key, at])),
        timeline: [...log.timeline],
        runs: { ...log.runs },
        subagents: [...log.subagents],
        usage: log.usage,
      }
    : { threadId, items: [], index: new Map(), timeline: [], runs: {}, subagents: [], usage: null };
  for (const event of events) applyEvent(working, event);
  const { items, timeline, runs, subagents, usage } = working;
  return { items, timeline, runs, subagents, usage };
}

/**
 * Folds a batch into the log. Replayed seqs are dropped; a seq that arrives
 * behind the log's head is inserted in order and the view is rebuilt.
 */
export function applyEvents(
  threadId: string,
  log: ThreadLog,
  incoming: readonly WireThreadEvent[],
): ThreadLog {
  const seen = new Set(log.seen);
  const fresh: WireThreadEvent[] = [];
  for (const event of incoming) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    fresh.push(event);
  }
  if (fresh.length === 0) return log;
  fresh.sort((a, b) => a.seq - b.seq);

  const first = fresh[0];
  const inOrder = first !== undefined && first.seq > log.lastSeq;
  const events = inOrder
    ? [...log.events, ...fresh]
    : [...log.events, ...fresh].sort((a, b) => a.seq - b.seq);
  const projected = inOrder
    ? fold(threadId, log, fresh, true)
    : fold(threadId, emptyLog, events, false);
  return {
    events,
    seen,
    lastSeq: Math.max(log.lastSeq, fresh.at(-1)?.seq ?? 0),
    ...projected,
  };
}
