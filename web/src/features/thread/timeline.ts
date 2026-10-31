import type { ThreadItem, ToolItem } from "./projection";

export type WorkItem = Extract<ThreadItem, { kind: "reasoning" | "tool" | "activity" }>;

export interface WorkGroup {
  kind: "work";
  key: string;
  items: WorkItem[];
  seconds: number;
}

export type TimelineEntry = Exclude<ThreadItem, WorkItem> | WorkGroup;

const isWork = (item: ThreadItem): item is WorkItem =>
  item.kind === "reasoning" || item.kind === "tool" || item.kind === "activity";

const secondsBetween = (first: string, last: string) => {
  const span = (new Date(last).getTime() - new Date(first).getTime()) / 1000;
  return Number.isFinite(span) ? Math.max(1, Math.round(span)) : 1;
};

/** Folds consecutive reasoning and tool calls into one collapsible work log. */
export function groupWork(items: readonly ThreadItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let run: WorkItem[] = [];
  const close = () => {
    const first = run[0];
    const last = run.at(-1);
    if (first && last) {
      entries.push({
        kind: "work",
        key: `work:${first.key}`,
        items: run,
        seconds: secondsBetween(first.ts, last.ts),
      });
    }
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

export const runningTools = (items: readonly ThreadItem[]): ToolItem[] =>
  items.filter((item): item is ToolItem => item.kind === "tool" && item.result === null && !item.done);
