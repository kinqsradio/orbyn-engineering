import type { TimelineEntry } from "../thread/projection";
import { traceTool, workDuration } from "../thread/toolTrace";

export type ActivityFilter = "all" | "commands" | "edits";

const TOOL = /^Tool: /;

const isCall = (entry: TimelineEntry) => TOOL.test(entry.label);
const action = (entry: TimelineEntry) => traceTool({ name: entry.label.replace(TOOL, ""), args: "{}" }).action;

/** All, or only the tool calls that ran a command or changed files. */
export function filterActivity(entries: readonly TimelineEntry[], filter: ActivityFilter): TimelineEntry[] {
  if (filter === "all") return [...entries];
  const wanted = filter === "commands" ? "command" : "edit";
  return entries.filter((entry) => (isCall(entry) ? action(entry) === wanted : filter === "edits" && entry.label === "Files changed"));
}

/** The calls made and the time from the first to the last; the time needs two stamped calls. */
export function summarizeActivity(entries: readonly TimelineEntry[]): string | null {
  const calls = entries.filter(isCall);
  if (calls.length === 0) return null;
  const count = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
  const times = calls.map((entry) => Date.parse(entry.ts)).filter((time) => !Number.isNaN(time));
  if (times.length < 2) return count;
  return `${count} · ${workDuration(Math.max(...times) - Math.min(...times))}`;
}
