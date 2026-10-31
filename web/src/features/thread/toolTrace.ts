import type { ReasoningItem, ToolItem } from "./projection";

/** What a tool call did, in the words the timeline uses for it. */
export type ToolAction = "command" | "edit" | "read" | "web" | "code-search" | "browser" | "other";

export interface ToolTrace {
  action: ToolAction;
  /** A verb-object sentence, or the command itself. */
  label: string;
  /** The command to show above its output. */
  command: string | null;
}

const READ = /^(read|view|cat|open|image_view|notebookread)/i;
const EDIT = /^(edit|multiedit|write|notebookedit|apply_patch|file_change)/i;
const CODE_SEARCH = /^(grep|glob|ls|find|search_files)/i;
const WEB = /^(web_?search|web_?fetch)/i;
const BROWSER = /(^|[._])(browser|preview)/i;
const COMMAND = /^(command|bash|shell|exec|powershell)/i;

const parsed = (args: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(args);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    // Arguments still streaming.
    return {};
  }
};

const firstText = (body: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const paths = (body: Record<string, unknown>): string[] => {
  const list = body.paths;
  if (Array.isArray(list)) return list.filter((entry): entry is string => typeof entry === "string");
  const one = firstText(body, "file_path", "path", "notebook_path");
  return one ? [one] : [];
};

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Reads what a call did from its name and arguments; engines name tools differently. */
export function traceTool(item: Pick<ToolItem, "name" | "args">): ToolTrace {
  const body = parsed(item.args);
  const name = item.name;
  const files = paths(body);
  const named = files.length === 1 ? baseName(files[0] ?? "") : `${files.length} files`;
  if (COMMAND.test(name)) {
    const command = firstText(body, "command", "cmd");
    return { action: "command", label: command ?? "Ran a command", command };
  }
  if (EDIT.test(name)) return { action: "edit", label: files.length ? `Changed ${named}` : "Changed files", command: null };
  if (READ.test(name)) return { action: "read", label: files.length ? `Read ${named}` : "Read a file", command: null };
  if (CODE_SEARCH.test(name)) {
    const query = firstText(body, "pattern", "query", "path");
    return { action: "code-search", label: query ? `Searched code for ${query}` : "Searched code", command: null };
  }
  if (WEB.test(name)) {
    const query = firstText(body, "query", "url");
    return { action: "web", label: query ? `Searched the web for ${query}` : "Searched the web", command: null };
  }
  if (BROWSER.test(name)) {
    const target = firstText(body, "url");
    return { action: "browser", label: target ? `Used browser on ${target}` : "Used browser", command: null };
  }
  const subject = firstText(body, "title", "name", "path", "query");
  return { action: "other", label: subject ? `${name} ${subject}` : name, command: null };
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** Commands, edits and other changes lead; a summary names at most two kinds of work. */
const PRIORITY: Record<ToolAction, number> = {
  command: 0,
  edit: 0,
  read: 1,
  web: 1,
  "code-search": 1,
  browser: 1,
  other: 2,
};

function actionSentence(action: ToolAction, count: number): string {
  switch (action) {
    case "command":
      return `Ran ${count} ${plural(count, "command", "commands")}`;
    case "edit":
      return `Changed ${count} ${plural(count, "file", "files")}`;
    case "read":
      return `Read ${count} ${plural(count, "file", "files")}`;
    case "web":
      return `Searched the web ${count} ${plural(count, "time", "times")}`;
    case "code-search":
      return `Searched code ${count} ${plural(count, "time", "times")}`;
    case "browser":
      return `Used browser ${count} ${plural(count, "time", "times")}`;
    case "other":
      return `Used ${count} ${plural(count, "tool", "tools")}`;
  }
}

/** A changed-file count, since one call can touch several files. */
const callWeight = (item: ToolItem): number => {
  if (traceTool(item).action !== "edit") return 1;
  return Math.max(paths(parsed(item.args)).length, 1);
};

export const toolFailed = (item: ToolItem) => item.exitCode !== null && item.exitCode !== 0;

export interface WorkSummary {
  summary: string;
  action: ToolAction | "mixed" | "reasoning";
  failed: boolean;
}

/** One line for a run of tool calls, such as "Ran 2 commands and changed 1 file". */
export function summarizeWork(items: readonly (ToolItem | ReasoningItem)[]): WorkSummary {
  const tools = items.filter((item): item is ToolItem => item.kind === "tool");
  if (tools.length === 0) {
    return {
      summary: items.length === 1 ? "Thought" : `Thought (×${items.length})`,
      action: "reasoning",
      failed: false,
    };
  }
  const groups = new Map<ToolAction, { calls: number; weight: number; order: number }>();
  for (const tool of tools) {
    const { action } = traceTool(tool);
    const group = groups.get(action) ?? { calls: 0, weight: 0, order: groups.size };
    groups.set(action, { ...group, calls: group.calls + 1, weight: group.weight + callWeight(tool) });
  }
  const picked = [...groups]
    .sort(([a, x], [b, y]) => PRIORITY[a] - PRIORITY[b] || x.order - y.order)
    .slice(0, 2)
    .sort(([, x], [, y]) => x.order - y.order);
  const labels = picked.map(([action, group]) => actionSentence(action, group.weight));
  const rest = tools.length - picked.reduce((sum, [, group]) => sum + group.calls, 0);
  if (rest > 0) labels.push(`Performed ${rest} other ${plural(rest, "action", "actions")}`);
  const sentence = labels.map((label, at) => (at === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  const summary =
    sentence.length < 3 ? sentence.join(" and ") : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
  return {
    summary,
    action: groups.size === 1 ? (picked[0]?.[0] ?? "other") : "mixed",
    failed: tools.some(toolFailed),
  };
}

/** Whole minutes and seconds, the way a finished turn reports its time. */
export function workDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`;
}
