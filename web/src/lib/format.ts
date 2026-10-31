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

/** "7m", "2h", "3d": the sidebar's age column. */
export function compactAge(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return "";
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** "18s", "3m 05s": how long something has been going. */
export function elapsed(fromIso: string, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - new Date(fromIso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Up to two letters for a project or engine badge, from its words. */
export function monogram(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const first = words[0] ?? name;
  const letters =
    words.length > 1 ? `${first[0] ?? ""}${words[1]?.[0] ?? ""}` : first.slice(0, 2);
  return letters.toUpperCase();
}

const BADGE_TINTS = 6;

/** A stable tint per name, so a project keeps its colour across sessions. */
export function badgeTint(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % BADGE_TINTS;
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
