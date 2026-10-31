import type {
  ActionKind,
  AuthState,
  EngineStatus,
  EngineTier,
  RunState,
  VersionSupport,
} from "../api/types";

export const runStateLabels: Record<RunState, string> = {
  admitted: "Queued",
  starting: "Starting",
  running: "Running",
  awaiting_approval: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export const authLabels: Record<AuthState, string> = {
  logged_in: "Signed in",
  logged_out: "Signed out",
  unknown: "Login unknown",
  not_applicable: "No login needed",
};

export const supportLabels: Record<VersionSupport, string> = {
  tested: "Tested",
  untested: "Untested",
  below_minimum: "Below minimum",
  unknown: "Not checked",
};

export const tierLabels: Record<EngineTier, string> = {
  native: "Native",
  acp: "ACP",
  agui: "AG-UI",
  terminal: "Terminal",
};

export const actionLabels: Record<ActionKind, string> = {
  command: "Command",
  file_change: "File change",
  tool: "Tool",
  computer: "Computer",
  browser: "Browser",
  network: "Network",
};

export const signInLabel = (engine: Pick<EngineStatus, "name">) =>
  `Sign in through the ${engine.name} CLI`;

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3 min ago" style; the absolute value goes in `title`/`dateTime`. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (now - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(seconds)) return "";
  if (Math.abs(seconds) < 60) return "Just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(-Math.round(seconds / size), unit);
  }
  return "";
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fullTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Pretty-prints JSON tool arguments; anything else is returned untouched. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Turns a free-form name into the slug the server expects for ids and worktrees. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
