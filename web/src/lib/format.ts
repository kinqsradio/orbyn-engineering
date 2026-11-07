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

export function clockTime(iso: string, format: "locale" | "12-hour" | "24-hour" = "locale"): string {
  const date = new Date(iso);
  const hour12 = format === "locale" ? undefined : format === "12-hour";
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12 });
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (value: number) => String(value).padStart(2, "0");
const clock24 = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** "Today 10:12", "Yesterday 16:40", "3 Nov 09:02": a time in a list, by the 24-hour clock. */
export function dayStamp(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);
  const clock = clock24(at);
  return days === 0 ? `Today ${clock}` : days === 1 ? `Yesterday ${clock}` : `${at.getDate()} ${MONTHS[at.getMonth()]} ${clock}`;
}

/** "Mon 9 Nov 07:00": a run's start, which can be days from now or long gone. */
export function weekdayStamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${clock24(at)}`;
}

/** "next Mon 9 Nov": a day named in a sentence. */
export function weekdayDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/** "45 s", "6 min", "2 h 10 min": how long a finished piece of work took. */
export function tookWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Whole megabytes, gigabytes with one decimal: the sizes the settings frames write. */
export function sizeWords(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1e6))} MB`;
}
